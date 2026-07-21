import Foundation
import JunoCore
import JunoStorage
import JunoSync
import Observation

public enum NativeChatRole: String, Equatable, Sendable {
    case user
    case assistant
    case system
    case tool

    fileprivate init(serverValue: String) throws {
        guard let value = Self(rawValue: serverValue.lowercased()) else {
            throw NativeConversationStoreError.invalidMessageRole(serverValue)
        }
        self = value
    }
}

public struct NativeConversation: Identifiable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var model: String
    public let kind: String
    public var pinned: Bool
    public var archivedAt: Date?
    public let createdAt: Date
    public var updatedAt: Date
    public var lastMessageAt: Date
    public let revision: UInt64
    public var isPending: Bool

    public var isArchived: Bool { archivedAt != nil }

    public init(
        id: String,
        title: String,
        model: String,
        kind: String = "chat",
        pinned: Bool,
        archivedAt: Date?,
        createdAt: Date,
        updatedAt: Date,
        lastMessageAt: Date,
        revision: UInt64,
        isPending: Bool = false
    ) {
        self.id = id
        self.title = title
        self.model = model
        self.kind = kind
        self.pinned = pinned
        self.archivedAt = archivedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastMessageAt = lastMessageAt
        self.revision = revision
        self.isPending = isPending
    }
}

public struct NativeChatMessage: Identifiable, Equatable, Sendable {
    public let id: String
    public let conversationID: String
    public let clientID: String?
    public let role: NativeChatRole
    public let content: String
    public let reasoning: String?
    public let model: String?
    public let createdAt: Date
    public let revision: UInt64

    public init(
        id: String,
        conversationID: String,
        clientID: String?,
        role: NativeChatRole,
        content: String,
        reasoning: String?,
        model: String?,
        createdAt: Date,
        revision: UInt64
    ) {
        self.id = id
        self.conversationID = conversationID
        self.clientID = clientID
        self.role = role
        self.content = content
        self.reasoning = reasoning
        self.model = model
        self.createdAt = createdAt
        self.revision = revision
    }
}

public struct NativeConversationSnapshot: Equatable, Sendable {
    public let conversations: [NativeConversation]
    public let messagesByConversation: [String: [NativeChatMessage]]
    public let pendingMutationCount: Int
    public let conflictedMutationCount: Int

    public init(
        conversations: [NativeConversation],
        messagesByConversation: [String: [NativeChatMessage]],
        pendingMutationCount: Int,
        conflictedMutationCount: Int
    ) {
        self.conversations = conversations
        self.messagesByConversation = messagesByConversation
        self.pendingMutationCount = pendingMutationCount
        self.conflictedMutationCount = conflictedMutationCount
    }
}

public enum NativeConversationStoreError: Error, Equatable, LocalizedError, Sendable {
    case corruptRecord(RecordKey)
    case invalidMessageRole(String)
    case invalidMutation
    case invalidTitle
    case invalidModel
    case conversationNotFound(String)
    case pendingConversation(String)

    public var errorDescription: String? {
        switch self {
        case .corruptRecord:
            "Juno could not read the locally stored conversation data."
        case .invalidMessageRole:
            "Juno returned an unsupported message role."
        case .invalidMutation:
            "The pending conversation change is invalid."
        case .invalidTitle:
            "Enter a conversation title."
        case .invalidModel:
            "Enter a valid model identifier."
        case .conversationNotFound:
            "The conversation is no longer available."
        case .pendingConversation:
            "Wait for this new conversation to finish synchronizing."
        }
    }
}

/// Projects authoritative encrypted sync records and durable pending mutations
/// into one account-isolated conversation snapshot.
public actor NativeConversationStore<Repository: AccountScopedRepository> {
    private let repository: Repository
    private let outbox: any MutationOutboxRepository

    public init(repository: Repository, outbox: any MutationOutboxRepository) {
        self.repository = repository
        self.outbox = outbox
    }

    public func load(accountID: StorageAccountID) async throws -> NativeConversationSnapshot {
        let snapshot = try await repository.snapshot(for: accountID)
        let mutations = try await outbox.mutations(accountID: accountID)
        var conversations: [String: NativeConversation] = [:]
        var messages: [String: [NativeChatMessage]] = [:]

        for record in snapshot.records.values where !record.isTombstone {
            switch record.key.namespace {
            case "conversation":
                let value = try decodeConversation(record)
                if value.kind == "chat" { conversations[value.id] = value }
            case "message":
                let value = try decodeMessage(record)
                messages[value.conversationID, default: []].append(value)
            default:
                break
            }
        }

        var pendingCount = 0
        var conflictCount = 0
        for mutation in mutations {
            guard mutation.draft.entity.namespace == "conversation" else { continue }
            switch mutation.state {
            case .pending, .leased, .retryScheduled:
                pendingCount += 1
                try apply(mutation, to: &conversations)
            case .conflicted:
                conflictCount += 1
            case .acknowledged, .discarded:
                break
            }
        }

        let orderedConversations = conversations.values.sorted(by: conversationOrder)
        let visibleIDs = Set(orderedConversations.map(\.id))
        let orderedMessages = messages.reduce(into: [String: [NativeChatMessage]]()) {
            guard visibleIDs.contains($1.key) else { return }
            $0[$1.key] = $1.value.sorted {
                $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
            }
        }
        return NativeConversationSnapshot(
            conversations: orderedConversations,
            messagesByConversation: orderedMessages,
            pendingMutationCount: pendingCount,
            conflictedMutationCount: conflictCount
        )
    }

    private func decodeConversation(_ record: StoredRecord) throws -> NativeConversation {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(ConversationWire.self, from: payload),
            wire.id == record.key.id,
            !wire.title.isEmpty,
            !wire.model.isEmpty,
            let createdAt = parseDate(wire.createdAt),
            let updatedAt = parseDate(wire.updatedAt),
            let lastMessageAt = parseDate(wire.lastMessageAt)
        else { throw NativeConversationStoreError.corruptRecord(record.key) }
        let archivedAt: Date?
        if let value = wire.archivedAt {
            guard let date = parseDate(value) else {
                throw NativeConversationStoreError.corruptRecord(record.key)
            }
            archivedAt = date
        } else {
            archivedAt = nil
        }
        return NativeConversation(
            id: wire.id,
            title: wire.title,
            model: wire.model,
            kind: wire.kind ?? "chat",
            pinned: wire.pinned,
            archivedAt: archivedAt,
            createdAt: createdAt,
            updatedAt: updatedAt,
            lastMessageAt: lastMessageAt,
            revision: record.revision
        )
    }

    private func decodeMessage(_ record: StoredRecord) throws -> NativeChatMessage {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(MessageWire.self, from: payload),
            wire.id == record.key.id,
            !wire.conversationId.isEmpty,
            let createdAt = parseDate(wire.createdAt)
        else { throw NativeConversationStoreError.corruptRecord(record.key) }
        return NativeChatMessage(
            id: wire.id,
            conversationID: wire.conversationId,
            clientID: wire.clientId,
            role: try NativeChatRole(serverValue: wire.role),
            content: wire.content,
            reasoning: wire.reasoning,
            model: wire.model,
            createdAt: createdAt,
            revision: record.revision
        )
    }

    private func apply(
        _ mutation: QueuedMutation,
        to conversations: inout [String: NativeConversation]
    ) throws {
        guard mutation.draft.entity.namespace == "conversation" else { return }
        guard let object = try JSONSerialization.jsonObject(
            with: mutation.draft.payload
        ) as? [String: Any], object["type"] as? String == mutation.draft.operation else {
            throw NativeConversationStoreError.invalidMutation
        }
        switch mutation.draft.operation {
        case "conversation.create":
            guard let clientID = object["clientEntityId"] as? String,
                clientID == mutation.draft.entity.id
            else { throw NativeConversationStoreError.invalidMutation }
            let now = mutation.draft.createdAt
            conversations[clientID] = NativeConversation(
                id: clientID,
                title: object["title"] as? String ?? "New conversation",
                model: object["model"] as? String ?? "default",
                pinned: false,
                archivedAt: nil,
                createdAt: now,
                updatedAt: now,
                lastMessageAt: now,
                revision: 0,
                isPending: true
            )
        case "conversation.rename":
            guard let title = object["title"] as? String else {
                throw NativeConversationStoreError.invalidMutation
            }
            conversations[mutation.draft.entity.id]?.title = title
            conversations[mutation.draft.entity.id]?.isPending = true
        case "conversation.update":
            guard let patch = object["patch"] as? [String: Any] else {
                throw NativeConversationStoreError.invalidMutation
            }
            if let title = patch["title"] as? String {
                conversations[mutation.draft.entity.id]?.title = title
            }
            if let model = patch["model"] as? String {
                conversations[mutation.draft.entity.id]?.model = model
            }
            if let pinned = patch["pinned"] as? Bool {
                conversations[mutation.draft.entity.id]?.pinned = pinned
            }
            conversations[mutation.draft.entity.id]?.isPending = true
        case "conversation.archive":
            let archived = object["archived"] as? Bool ?? true
            conversations[mutation.draft.entity.id]?.archivedAt = archived
                ? mutation.draft.createdAt : nil
            conversations[mutation.draft.entity.id]?.isPending = true
        case "conversation.delete":
            conversations.removeValue(forKey: mutation.draft.entity.id)
        default:
            break
        }
    }

    private func conversationOrder(_ lhs: NativeConversation, _ rhs: NativeConversation) -> Bool {
        if lhs.isArchived != rhs.isArchived { return !lhs.isArchived }
        if lhs.pinned != rhs.pinned { return lhs.pinned }
        if lhs.lastMessageAt != rhs.lastMessageAt { return lhs.lastMessageAt > rhs.lastMessageAt }
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
public final class NativeConversationModel<Repository: AccountScopedRepository> {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case offline
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var conversations: [NativeConversation] = []
    public private(set) var messagesByConversation: [String: [NativeChatMessage]] = [:]
    public private(set) var pendingMutationCount = 0
    public private(set) var conflictedMutationCount = 0
    public private(set) var lastErrorDescription: String?
    public private(set) var isMutating = false
    public var selectedConversationID: String?

    public var selectedConversation: NativeConversation? {
        conversations.first { $0.id == selectedConversationID }
    }

    public var selectedMessages: [NativeChatMessage] {
        selectedConversationID.flatMap { messagesByConversation[$0] } ?? []
    }

    private let store: NativeConversationStore<Repository>
    private let outbox: any MutationOutboxRepository
    private let drainer: NativeMutationDrainer<Repository>
    private let syncModel: NativeSyncModel<Repository>
    private var accountID: AccountID?
    private var lastSynchronizationGeneration = -1
    private var isReconciling = false

    public init(
        repository: Repository,
        outbox: any MutationOutboxRepository,
        drainer: NativeMutationDrainer<Repository>,
        syncModel: NativeSyncModel<Repository>
    ) {
        store = NativeConversationStore(repository: repository, outbox: outbox)
        self.outbox = outbox
        self.drainer = drainer
        self.syncModel = syncModel
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
        conversations = []
        messagesByConversation = [:]
        pendingMutationCount = 0
        conflictedMutationCount = 0
        lastErrorDescription = nil
        selectedConversationID = nil
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
        let storageAccountID = StorageAccountID(accountID.rawValue)
        do {
            let snapshot = try await store.load(accountID: storageAccountID)
            guard self.accountID == accountID else { return }
            conversations = snapshot.conversations
            messagesByConversation = snapshot.messagesByConversation
            pendingMutationCount = snapshot.pendingMutationCount
            conflictedMutationCount = snapshot.conflictedMutationCount
            if let selectedConversationID,
                !conversations.contains(where: { $0.id == selectedConversationID })
            {
                self.selectedConversationID = nil
            }
            if selectedConversationID == nil {
                selectedConversationID = conversations.first(where: { !$0.isArchived })?.id
            }
            lastErrorDescription = snapshot.conflictedMutationCount == 0
                ? nil : "A conversation change needs your attention."
            phase = syncModel.phase == .offline ? .offline : .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = error.localizedDescription
            phase = .failed
        }
    }

    @discardableResult
    public func createConversation(
        title: String = "New conversation",
        model: String? = nil
    ) async -> String? {
        guard let accountID else { return nil }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty, trimmedTitle.utf8.count <= 200 else {
            lastErrorDescription = NativeConversationStoreError.invalidTitle.localizedDescription
            return nil
        }
        let clientID = UUID().uuidString.lowercased()
        var operation: [String: Any] = [
            "type": "conversation.create",
            "clientEntityId": clientID,
            "title": trimmedTitle,
            "kind": "chat",
        ]
        if let model {
            let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedModel.isEmpty, trimmedModel.utf8.count <= 200 else {
                lastErrorDescription = NativeConversationStoreError.invalidModel.localizedDescription
                return nil
            }
            operation["model"] = trimmedModel
        }
        selectedConversationID = clientID
        await enqueueAndDrain(
            operation: "conversation.create",
            entityID: clientID,
            object: operation,
            accountID: accountID
        )
        return clientID
    }

    public func renameConversation(id: String, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 200 else {
            lastErrorDescription = NativeConversationStoreError.invalidTitle.localizedDescription
            return
        }
        await mutateExisting(
            id: id,
            operation: "conversation.rename",
            object: ["type": "conversation.rename", "entityId": id, "title": trimmed]
        )
    }

    public func setModel(id: String, model: String) async {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 200 else {
            lastErrorDescription = NativeConversationStoreError.invalidModel.localizedDescription
            return
        }
        await mutateExisting(
            id: id,
            operation: "conversation.update",
            object: [
                "type": "conversation.update", "entityId": id,
                "patch": ["model": trimmed],
            ]
        )
    }

    public func setPinned(id: String, pinned: Bool) async {
        await mutateExisting(
            id: id,
            operation: "conversation.update",
            object: [
                "type": "conversation.update", "entityId": id,
                "patch": ["pinned": pinned],
            ]
        )
    }

    public func setArchived(id: String, archived: Bool) async {
        await mutateExisting(
            id: id,
            operation: "conversation.archive",
            object: [
                "type": "conversation.archive", "entityId": id,
                "archived": archived,
            ]
        )
    }

    private func mutateExisting(
        id: String,
        operation: String,
        object: [String: Any]
    ) async {
        guard let accountID else { return }
        guard let conversation = conversations.first(where: { $0.id == id }) else {
            lastErrorDescription = NativeConversationStoreError
                .conversationNotFound(id).localizedDescription
            return
        }
        guard !conversation.isPending else {
            lastErrorDescription = NativeConversationStoreError
                .pendingConversation(id).localizedDescription
            return
        }
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
            lastErrorDescription = NativeConversationStoreError.invalidMutation.localizedDescription
            return
        }
        let mutationID = UUID().uuidString.lowercased()
        let draft = MutationDraft(
            id: OutboxMutationID(mutationID),
            accountID: StorageAccountID(accountID.rawValue),
            idempotencyKey: IdempotencyKey(UUID().uuidString.lowercased()),
            entity: RecordKey(namespace: "conversation", id: entityID),
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
            let result = try await drainer.drain(
                for: accountID,
                owner: "conversation-ui"
            )
            if result.acknowledged > 0 {
                await syncModel.refresh()
            }
            await reload()
            if result.retryScheduled > 0 {
                lastErrorDescription = "Changes are saved and will sync when Juno reconnects."
                phase = .offline
            } else if result.conflicted > 0 {
                lastErrorDescription = "A conversation changed on another device. Refresh before retrying."
                phase = .failed
            }
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = error.localizedDescription
            phase = .failed
        }
    }
}

private struct ConversationWire: Decodable {
    let id: String
    let title: String
    let model: String
    let kind: String?
    let pinned: Bool
    let archivedAt: String?
    let createdAt: String
    let updatedAt: String
    let lastMessageAt: String
}

private struct MessageWire: Decodable {
    let id: String
    let conversationId: String
    let clientId: String?
    let role: String
    let content: String
    let reasoning: String?
    let model: String?
    let createdAt: String
}

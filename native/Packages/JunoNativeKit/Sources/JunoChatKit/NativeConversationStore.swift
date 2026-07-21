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
    public var id: String
    public let conversationID: String
    public let clientID: String?
    public let role: NativeChatRole
    public var content: String
    public var reasoning: String?
    public var model: String?
    public var createdAt: Date
    public let revision: UInt64
    public var sources: [NativeChatSource]
    public var finishReason: NativeChatFinishReason?
    public var isPending: Bool
    public var errorDescription: String?

    public init(
        id: String,
        conversationID: String,
        clientID: String?,
        role: NativeChatRole,
        content: String,
        reasoning: String?,
        model: String?,
        createdAt: Date,
        revision: UInt64,
        sources: [NativeChatSource] = [],
        finishReason: NativeChatFinishReason? = nil,
        isPending: Bool = false,
        errorDescription: String? = nil
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
        self.sources = sources
        self.finishReason = finishReason
        self.isPending = isPending
        self.errorDescription = errorDescription
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

public enum NativeChatGenerationPhase: Equatable, Sendable {
    case idle
    case appending
    case submitting
    case reasoning
    case streaming
    case stopping
    case reconnecting
    case failed

    public var isActive: Bool {
        switch self {
        case .appending, .submitting, .reasoning, .streaming, .stopping,
             .reconnecting:
            true
        case .idle, .failed:
            false
        }
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
    public private(set) var modelCatalog: [NativeChatModelOption] = []
    public private(set) var modelCatalogErrorDescription: String?
    public private(set) var chatPhase: NativeChatGenerationPhase = .idle
    public private(set) var chatErrorDescription: String?
    public private(set) var activeChatConversationID: String?
    public var selectedConversationID: String?

    public var selectedConversation: NativeConversation? {
        conversations.first { $0.id == selectedConversationID }
    }

    public var selectedMessages: [NativeChatMessage] {
        selectedConversationID.map { visibleMessages(for: $0) } ?? []
    }

    public var isGenerating: Bool { chatPhase.isActive }

    public var canRetrySelectedConversation: Bool {
        selectedConversationID.flatMap { retryContexts[$0] } != nil
    }

    private let store: NativeConversationStore<Repository>
    private let outbox: any MutationOutboxRepository
    private let drainer: NativeMutationDrainer<Repository>
    private let syncModel: NativeSyncModel<Repository>
    private let chatClient: NativeChatAPIClient?
    private var accountID: AccountID?
    private var lastSynchronizationGeneration = -1
    private var isReconciling = false
    private var transientMessagesByConversation: [String: [NativeChatMessage]] = [:]
    private var retryContexts: [String: RetryContext] = [:]
    private var generationTask: Task<Void, Never>?
    private var activeGenerationID: String?

    private struct RetryContext: Sendable {
        let accountID: AccountID
        let conversationID: String
        let clientID: String
        let prompt: String
        let modelID: String
        let reasoningEffort: NativeReasoningEffort?
        var userMessageID: String?
        var userCreatedAt: Date
    }

    public init(
        repository: Repository,
        outbox: any MutationOutboxRepository,
        drainer: NativeMutationDrainer<Repository>,
        syncModel: NativeSyncModel<Repository>,
        chatClient: NativeChatAPIClient? = nil
    ) {
        store = NativeConversationStore(repository: repository, outbox: outbox)
        self.outbox = outbox
        self.drainer = drainer
        self.syncModel = syncModel
        self.chatClient = chatClient
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
        await reloadModelCatalog()
    }

    public func stop() {
        generationTask?.cancel()
        generationTask = nil
        activeGenerationID = nil
        accountID = nil
        conversations = []
        messagesByConversation = [:]
        transientMessagesByConversation = [:]
        retryContexts = [:]
        pendingMutationCount = 0
        conflictedMutationCount = 0
        lastErrorDescription = nil
        modelCatalog = []
        modelCatalogErrorDescription = nil
        chatPhase = .idle
        chatErrorDescription = nil
        activeChatConversationID = nil
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
            pruneTransientMessages()
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

    public func messages(for conversationID: String) -> [NativeChatMessage] {
        visibleMessages(for: conversationID)
    }

    public func reloadModelCatalog() async {
        guard let accountID, let chatClient else { return }
        do {
            let catalog = try await chatClient.modelCatalog(for: accountID)
            guard self.accountID == accountID else { return }
            modelCatalog = catalog.models.filter(\.isAvailable)
            modelCatalogErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            modelCatalogErrorDescription = error.localizedDescription
        }
    }

    @discardableResult
    public func sendMessage(
        conversationID: String,
        prompt: String,
        modelID: String,
        reasoningEffort: NativeReasoningEffort?
    ) -> Bool {
        guard !chatPhase.isActive, let accountID, chatClient != nil,
            let conversation = conversations.first(where: { $0.id == conversationID }),
            !conversation.isPending
        else {
            chatErrorDescription = conversationPendingMessage(conversationID)
            return false
        }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            chatErrorDescription = NativeChatAPIError.invalidMessage.localizedDescription
            return false
        }
        guard validModelSelection(modelID, effort: reasoningEffort) else {
            chatErrorDescription = "Choose a model and reasoning level available to this account."
            return false
        }
        let clientID = UUID().uuidString.lowercased()
        let now = Date()
        let context = RetryContext(
            accountID: accountID,
            conversationID: conversationID,
            clientID: clientID,
            prompt: trimmed,
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            userMessageID: nil,
            userCreatedAt: now
        )
        retryContexts.removeValue(forKey: conversationID)
        chatErrorDescription = nil
        activeChatConversationID = conversationID
        chatPhase = .appending
        appendTransient(
            NativeChatMessage(
                id: "local-user-\(clientID)",
                conversationID: conversationID,
                clientID: clientID,
                role: .user,
                content: trimmed,
                reasoning: nil,
                model: nil,
                createdAt: now,
                revision: 0,
                isPending: true
            )
        )
        appendAssistantPlaceholder(for: context)
        if let index = conversations.firstIndex(where: { $0.id == conversationID }) {
            conversations[index].model = modelID
            conversations[index].lastMessageAt = now
        }
        launchGeneration(context, needsAppend: true)
        return true
    }

    public func retryLastMessage(conversationID: String) {
        guard !chatPhase.isActive, let context = retryContexts[conversationID],
            accountID == context.accountID
        else { return }
        chatErrorDescription = nil
        activeChatConversationID = conversationID
        chatPhase = context.userMessageID == nil ? .appending : .submitting
        removeTransientAssistant(for: conversationID)
        appendAssistantPlaceholder(for: context)
        launchGeneration(context, needsAppend: context.userMessageID == nil)
    }

    public func stopGeneration() {
        guard chatPhase.isActive, let accountID, let generationID = activeGenerationID,
            let chatClient
        else { return }
        chatPhase = .stopping
        Task { @MainActor [weak self] in
            do {
                _ = try await chatClient.cancelGeneration(id: generationID, for: accountID)
            } catch {
                guard let self, self.accountID == accountID else { return }
                self.chatErrorDescription = error.localizedDescription
                self.chatPhase = .reconnecting
            }
        }
    }

    private func launchGeneration(_ context: RetryContext, needsAppend: Bool) {
        generationTask?.cancel()
        generationTask = Task { @MainActor [weak self] in
            await self?.performGeneration(context, needsAppend: needsAppend)
        }
    }

    private func performGeneration(
        _ initialContext: RetryContext,
        needsAppend: Bool
    ) async {
        guard let chatClient, accountID == initialContext.accountID else { return }
        var context = initialContext
        do {
            if needsAppend {
                chatPhase = .appending
                let appended = try await chatClient.appendUserMessage(
                    conversationID: context.conversationID,
                    clientID: context.clientID,
                    content: context.prompt,
                    for: context.accountID
                )
                guard accountID == context.accountID else { return }
                context.userMessageID = appended.id
                context.userCreatedAt = appended.createdAt
                replaceTransientUser(with: appended, conversationID: context.conversationID)
            }

            let generationID = "juno-native-\(UUID().uuidString.lowercased())"
            activeGenerationID = generationID
            chatPhase = .submitting
            let events = try await chatClient.generationEvents(
                NativeChatGenerationRequest(
                    conversationID: context.conversationID,
                    modelID: context.modelID,
                    reasoningEffort: context.reasoningEffort,
                    generationID: generationID
                ),
                for: context.accountID
            )
            var terminal = false
            for try await event in events {
                try Task.checkCancellation()
                guard accountID == context.accountID,
                    activeGenerationID == generationID
                else { return }
                switch event {
                case .metadata(let conversationID, _, let title, let serverGenerationID):
                    guard conversationID == context.conversationID,
                        serverGenerationID == nil || serverGenerationID == generationID
                    else { throw NativeChatAPIError.malformedResponse }
                    updateTitle(title, conversationID: conversationID)
                case .title(let conversationID, let title):
                    guard conversationID == context.conversationID else {
                        throw NativeChatAPIError.malformedResponse
                    }
                    updateTitle(title, conversationID: conversationID)
                case .textDelta(let text):
                    appendAssistantText(text, conversationID: context.conversationID)
                    chatPhase = .streaming
                case .reasoningDelta(let text):
                    appendAssistantReasoning(text, conversationID: context.conversationID)
                    if chatPhase == .submitting { chatPhase = .reasoning }
                case .sources(let sources):
                    updateAssistantSources(sources, conversationID: context.conversationID)
                case .completed(let message):
                    completeAssistant(message, conversationID: context.conversationID)
                    retryContexts.removeValue(forKey: context.conversationID)
                    terminal = true
                case .failed(let message, let reason, _, _):
                    failAssistant(
                        message,
                        reason: reason,
                        context: context
                    )
                    terminal = true
                case .ping:
                    break
                }
                if terminal { break }
            }
            guard terminal else {
                throw NativeChatAPIError.streamEndedWithoutTerminalEvent
            }
            activeGenerationID = nil
            generationTask = nil
            activeChatConversationID = nil
            if chatPhase != .failed { chatPhase = .idle }
            await syncModel.refresh()
            await reload()
        } catch is CancellationError {
            return
        } catch {
            guard accountID == context.accountID else { return }
            if shouldRecover(error) {
                chatErrorDescription = NativeChatAPIError
                    .streamEndedWithoutTerminalEvent.localizedDescription
                chatPhase = .reconnecting
                retryContexts[context.conversationID] = context
                await recoverPersistedGeneration(context)
            } else {
                failAssistant(
                    error.localizedDescription,
                    reason: .error,
                    context: context
                )
                activeGenerationID = nil
                generationTask = nil
                activeChatConversationID = nil
                await syncModel.refresh()
                await reload()
            }
        }
    }

    private func recoverPersistedGeneration(_ context: RetryContext) async {
        let policy = NativeSyncBackoffPolicy(initialDelay: 1, maximumDelay: 30)
        let jitter = SystemNativeSyncJitterSource()
        let sleeper = SystemNativeSyncSleeper()
        var attempt = 0
        while attempt < 12, !Task.isCancelled, accountID == context.accountID,
            activeChatConversationID == context.conversationID
        {
            await syncModel.refresh()
            await reload()
            if persistedAssistantExists(after: context.userCreatedAt, in: context.conversationID) {
                removeTransientAssistant(for: context.conversationID)
                retryContexts.removeValue(forKey: context.conversationID)
                activeGenerationID = nil
                generationTask = nil
                activeChatConversationID = nil
                chatErrorDescription = nil
                chatPhase = .idle
                return
            }
            do {
                let delay = policy.delay(
                    attempt: attempt,
                    randomUnit: await jitter.nextUnit()
                )
                attempt += 1
                try await sleeper.sleep(seconds: delay)
            } catch {
                return
            }
        }
        guard !Task.isCancelled, accountID == context.accountID,
            activeChatConversationID == context.conversationID
        else { return }
        let message = "Juno could not confirm the saved response after reconnecting. Retry the response when the network is stable."
        failAssistant(message, reason: .networkError, context: context)
        activeGenerationID = nil
        generationTask = nil
        activeChatConversationID = nil
    }

    private func shouldRecover(_ error: any Error) -> Bool {
        if let error = error as? NativeChatAPIError {
            switch error {
            case .streamEndedWithoutTerminalEvent: true
            case .server(_, _, _, let retryable): retryable
            default: false
            }
        } else {
            true
        }
    }

    private func failAssistant(
        _ message: String,
        reason: NativeChatFinishReason,
        context: RetryContext
    ) {
        updateTransientAssistant(for: context.conversationID) {
            $0.isPending = false
            $0.errorDescription = message
            $0.finishReason = reason
        }
        retryContexts[context.conversationID] = context
        chatErrorDescription = message
        chatPhase = .failed
    }

    private func completeAssistant(
        _ message: NativeCompletedChatMessage,
        conversationID: String
    ) {
        updateTransientAssistant(for: conversationID) {
            $0.id = message.id
            $0.content = message.content
            $0.reasoning = message.reasoning
            $0.model = message.model
            $0.createdAt = message.createdAt
            $0.sources = message.sources
            $0.finishReason = message.finishReason
            $0.isPending = false
            $0.errorDescription = nil
        }
    }

    private func appendAssistantPlaceholder(for context: RetryContext) {
        appendTransient(NativeChatMessage(
            id: "local-assistant-\(UUID().uuidString.lowercased())",
            conversationID: context.conversationID,
            clientID: nil,
            role: .assistant,
            content: "",
            reasoning: nil,
            model: context.modelID,
            createdAt: max(Date(), context.userCreatedAt.addingTimeInterval(0.001)),
            revision: 0,
            isPending: true
        ))
    }

    private func appendAssistantText(_ text: String, conversationID: String) {
        updateTransientAssistant(for: conversationID) { $0.content.append(text) }
    }

    private func appendAssistantReasoning(_ text: String, conversationID: String) {
        updateTransientAssistant(for: conversationID) {
            $0.reasoning = ($0.reasoning ?? "") + text
        }
    }

    private func updateAssistantSources(
        _ sources: [NativeChatSource],
        conversationID: String
    ) {
        updateTransientAssistant(for: conversationID) { $0.sources = sources }
    }

    private func updateTransientAssistant(
        for conversationID: String,
        _ update: (inout NativeChatMessage) -> Void
    ) {
        guard var messages = transientMessagesByConversation[conversationID],
            let index = messages.lastIndex(where: { $0.role == .assistant })
        else { return }
        update(&messages[index])
        transientMessagesByConversation[conversationID] = messages
    }

    private func replaceTransientUser(
        with message: NativeAppendedUserMessage,
        conversationID: String
    ) {
        guard var messages = transientMessagesByConversation[conversationID],
            let index = messages.firstIndex(where: { $0.clientID == message.clientID })
        else { return }
        messages[index].id = message.id
        messages[index].content = message.content
        messages[index].createdAt = message.createdAt
        messages[index].isPending = false
        if let assistantIndex = messages.lastIndex(where: {
            $0.role == .assistant && $0.isPending
        }), messages[assistantIndex].createdAt <= message.createdAt {
            messages[assistantIndex].createdAt = message.createdAt.addingTimeInterval(0.001)
        }
        transientMessagesByConversation[conversationID] = messages
    }

    private func appendTransient(_ message: NativeChatMessage) {
        transientMessagesByConversation[message.conversationID, default: []]
            .append(message)
    }

    private func removeTransientAssistant(for conversationID: String) {
        transientMessagesByConversation[conversationID]?.removeAll {
            $0.role == .assistant
        }
    }

    private func visibleMessages(for conversationID: String) -> [NativeChatMessage] {
        var result = messagesByConversation[conversationID] ?? []
        let persistedIDs = Set(result.map(\.id))
        let persistedClientIDs = Set(result.compactMap(\.clientID))
        for transient in transientMessagesByConversation[conversationID] ?? []
        where !persistedIDs.contains(transient.id)
            && (transient.clientID == nil || !persistedClientIDs.contains(transient.clientID!))
        {
            result.append(transient)
        }
        return result.sorted {
            $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
        }
    }

    private func pruneTransientMessages() {
        for conversationID in Array(transientMessagesByConversation.keys) {
            let persisted = messagesByConversation[conversationID] ?? []
            let persistedIDs = Set(persisted.map(\.id))
            let persistedClientIDs = Set(persisted.compactMap(\.clientID))
            transientMessagesByConversation[conversationID]?.removeAll { transient in
                persistedIDs.contains(transient.id)
                    || transient.clientID.map(persistedClientIDs.contains) == true
            }
            if transientMessagesByConversation[conversationID]?.isEmpty == true {
                transientMessagesByConversation.removeValue(forKey: conversationID)
            }
        }
    }

    private func persistedAssistantExists(after date: Date, in conversationID: String) -> Bool {
        (messagesByConversation[conversationID] ?? []).contains {
            $0.role == .assistant && $0.createdAt >= date
        }
    }

    private func updateTitle(_ title: String, conversationID: String) {
        guard !title.isEmpty,
            let index = conversations.firstIndex(where: { $0.id == conversationID })
        else { return }
        conversations[index].title = title
    }

    private func validModelSelection(
        _ modelID: String,
        effort: NativeReasoningEffort?
    ) -> Bool {
        guard !modelID.isEmpty, modelID.utf8.count <= 200 else { return false }
        guard let model = modelCatalog.first(where: { $0.id == modelID }) else {
            return modelCatalog.isEmpty
        }
        guard let effort else { return model.canDisableReasoning || model.supportedReasoningEfforts.isEmpty }
        return model.supportedReasoningEfforts.contains(effort)
    }

    private func conversationPendingMessage(_ id: String) -> String {
        if conversations.first(where: { $0.id == id })?.isPending == true {
            return NativeConversationStoreError.pendingConversation(id).localizedDescription
        }
        return NativeConversationStoreError.conversationNotFound(id).localizedDescription
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

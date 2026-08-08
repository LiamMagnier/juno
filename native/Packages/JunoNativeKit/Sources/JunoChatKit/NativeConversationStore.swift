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
    /// The project this conversation is associated with, if any.
    public var projectId: String?

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
        isPending: Bool = false,
        projectId: String? = nil
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
        self.projectId = projectId
    }
}

/// A reader's rating of one answer. Nullable on the wire and here: clearing a
/// thumb is a real operation, not the absence of one.
public enum NativeChatFeedback: String, Equatable, Sendable {
    case up = "UP"
    case down = "DOWN"
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
    /// What this answer cost, in US dollars.
    ///
    /// The server's own figure, not an estimate made here: it is written at
    /// generation time from tokens *plus* cache writes and tool fees, and a
    /// client recomputing it from token counts alone under-reports badly. The
    /// native model manifest carries a price tier, not per-token rates, so there
    /// is nothing to recompute from anyway. Nil on user turns, on anything
    /// written before the column existed, and while a reply is still streaming.
    public var costUSD: Double?
    /// The reader's rating, as the server holds it.
    public var feedback: NativeChatFeedback?
    /// Live media-generation progress, while `/api/generate` runs.
    ///
    /// Client-transient and never persisted — exactly as `progress` is on the
    /// web's message model. It exists only between the request and the `done`
    /// frame that replaces this row with the finished message, and a value that
    /// survived a reload would be claiming a generation that is not running.
    public var mediaProgress: NativeMediaProgress?

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
        errorDescription: String? = nil,
        costUSD: Double? = nil,
        feedback: NativeChatFeedback? = nil,
        mediaProgress: NativeMediaProgress? = nil
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
        self.costUSD = costUSD
        self.mediaProgress = mediaProgress
        self.feedback = feedback
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
                // "chat" and "code" both belong here. A Juno Code conversation
                // with no project is answered by the chat pipeline, and
                // `sendMessage` refuses any conversation this store has never
                // heard of — so filtering it out here is what would make the
                // Code section unable to talk to the thing it just created.
                if value.kind == "chat" || value.kind == "code" {
                    conversations[value.id] = value
                }
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
            revision: record.revision,
            projectId: wire.projectId
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
            revision: record.revision,
            // Micro-USD on the wire, dollars here. Zero is treated as absent:
            // the column defaults to nothing for turns that were never billed,
            // and "$0" under an answer reads as a claim rather than a gap.
            costUSD: wire.costMicroUsd.flatMap { $0 > 0 ? Double($0) / 1_000_000 : nil },
            feedback: wire.feedback.flatMap(NativeChatFeedback.init(rawValue:))
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
                isPending: true,
                projectId: object["projectId"] as? String
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
            if patch.keys.contains("projectId") {
                // Present with a String value associates; present as null removes.
                conversations[mutation.draft.entity.id]?.projectId = patch["projectId"] as? String
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
    /// Every streaming chat model the server published for this account, in the
    /// server's display order — including ones the plan cannot call, so the
    /// picker can show them disabled *with a reason* instead of hiding them and
    /// leaving the user to wonder where a model went. Image/video generation
    /// entries are not here: they are a different product, not a gated chat model.
    public private(set) var modelCatalog: [NativeChatModelOption] = []
    public private(set) var modelCatalogErrorDescription: String?

    /// The subset that can actually be sent to right now.
    public var selectableModels: [NativeChatModelOption] {
        modelCatalog.filter(\.isAvailable)
    }

    public func model(withID id: String) -> NativeChatModelOption? {
        modelCatalog.first { $0.id == id }
    }
    public private(set) var chatPhase: NativeChatGenerationPhase = .idle
    public private(set) var chatErrorDescription: String?
    public private(set) var activeChatConversationID: String?
    /// Approval receipts raised by chat connector calls, keyed by conversation.
    ///
    /// They are kept outside persisted message rows because the receipt itself
    /// is the durable record and `/api/approvals` is the recovery source. The
    /// live SSE adds to this map immediately; a cold native launch fills it from
    /// the same route so a missed stream cannot leave an action unanswerable.
    public private(set) var chatApprovalsByConversation: [String: [NativeChatApproval]] = [:]
    public private(set) var chatApprovalInFlightID: String?
    public var selectedConversationID: String?
    /// True while the reader is composing a chat that does not exist yet. It
    /// suppresses the "open the most recent conversation" fallback in
    /// ``reload()`` — without it, the first sync tick after tapping New chat
    /// would drop the reader back into the conversation they just left.
    public var isDraftingNewConversation = false

    /// Whether ``reload()`` may fall back to opening the most recent
    /// conversation when nothing is selected.
    ///
    /// The caller chooses whether the first reload should select the newest
    /// conversation. Both the phone and desktop now pass `false`, so they open
    /// on the greeting and empty composer while the sidebar still exposes the
    /// conversation history.
    public var opensMostRecentConversationOnLoad: Bool

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

    /// Whether the last response ended at a recoverable boundary rather than a
    /// terminal error. The web offers this as "Continue" for the two cases
    /// where the reader has a useful partial answer; native used to expose only
    /// Retry, which discarded that partial answer and re-ran the original turn.
    public var canContinueSelectedConversation: Bool {
        guard !chatPhase.isActive,
            let conversationID = selectedConversationID,
            retryContexts[conversationID] != nil,
            let lastAssistant = visibleMessages(for: conversationID).last(where: {
                $0.role == .assistant
            })
        else { return false }
        return lastAssistant.finishReason == .length
            || lastAssistant.finishReason == .networkError
    }

    /// The conversation whose title the server has just replaced, so the screen
    /// showing it can animate the change rather than swapping the text under the
    /// reader's eyes. Cleared by ``acknowledgeTitleAnimation(for:)``.
    public private(set) var recentlyRenamedConversationID: String?

    private let store: NativeConversationStore<Repository>
    private let outbox: any MutationOutboxRepository
    private let drainer: NativeMutationDrainer<Repository>
    private let syncModel: NativeSyncModel<Repository>
    private let chatClient: NativeChatAPIClient?
    private let titleClient: NativeConversationTitleClient?
    /// Which naming passes each conversation has already had this session.
    ///
    /// Two, matching the website's ladder: `first_user` names the chat from the
    /// question as soon as it is asked, and `completed` re-reads it once the
    /// answer exists and refines the name from what the exchange turned out to
    /// be about. The web fires four (`thinking` and `writing` as well); those two
    /// only exist to make the title settle *during* a long stream in a browser
    /// tab, and on a phone they would spend the route's rate limit re-naming a
    /// chat the reader is watching.
    ///
    /// Keyed rather than a flat set because the server is idempotent per phase
    /// but a request per streamed turn would burn the rate limit for nothing.
    private var titlePhasesRun: [String: Set<NativeConversationTitleClient.Phase>] = [:]
    private var accountID: AccountID?
    private var lastSynchronizationGeneration = -1
    private var isReconciling = false
    private var transientMessagesByConversation: [String: [NativeChatMessage]] = [:]
    private var retryContexts: [String: RetryContext] = [:]
    private var generationTask: Task<Void, Never>?
    private var activeGenerationID: String?
    private var chatApprovalErrors: [String: String] = [:]
    private var chatApprovalScopeRefusals = Set<String>()

    /// Steps the server has reported for the generation in flight, newest last.
    ///
    /// Deep research runs PLAN → SEARCH → READ for tens of seconds before a
    /// single token of the report arrives, so without these the screen is an
    /// empty bubble and a spinner for the whole prep phase. Cleared when a new
    /// generation starts, because last turn's search steps above this turn's
    /// answer would be actively misleading.
    public private(set) var researchActivity: [NativeChatActivity] = []

    /// The warning the server emits when research degrades to a plain answer.
    /// Surfaced separately because it changes what the answer *is* — a reader
    /// who asked for research and silently got plain chat has been misled.
    public var researchDegradedWarning: String? {
        researchActivity.last { $0.kind == .warning }?.detail
            ?? researchActivity.last { $0.kind == .warning }?.title
    }

    /// Live generation progress on the pending assistant row.
    ///
    /// Transient by construction: it is set here and cleared by whatever replaces
    /// the row — the `done` frame's real message, or a failure. There is no path
    /// that persists it, which is what keeps a reloaded transcript from showing a
    /// generation that finished hours ago as still running.
    private func updateMediaProgress(_ progress: NativeMediaProgress, conversationID: String) {
        updateTransientAssistant(for: conversationID) { $0.mediaProgress = progress }
    }

    private func recordActivity(_ activity: NativeChatActivity, conversationID: String) {
        guard activeChatConversationID == conversationID else { return }
        // The server re-sends an entry when it gains a detail, so replace in
        // place rather than appending a near-duplicate step.
        if let index = researchActivity.firstIndex(where: { $0.id == activity.id }) {
            researchActivity[index] = activity
        } else {
            researchActivity.append(activity)
        }
    }

    private struct RetryContext: Sendable {
        let accountID: AccountID
        let conversationID: String
        let clientID: String
        let prompt: String
        let modelID: String
        let reasoningEffort: NativeReasoningEffort?
        /// Carried through retries so a resend claims the same uploads rather
        /// than losing them. Claiming is idempotent per attachment — the second
        /// attempt finds `messageId` already set and the server refuses — so a
        /// retry of a *successful* append must not re-send them; this is only
        /// re-sent when the append itself never landed.
        let attachmentIDs: [String]
        /// Carried through retries so a resend is still the research request the
        /// reader asked for, rather than silently downgrading to plain chat. The
        /// three tool flags beside it travel for the same reason: a retry that
        /// dropped the reader's web search or their chosen connectors would
        /// answer a different question from the one they asked.
        let deepResearch: Bool
        let webSearch: Bool
        let canvasEnabled: Bool?
        let connectors: [String]
        /// Same reason again, and with money attached: a retry that dropped
        /// Flash would answer more slowly than the reader paid for, and one that
        /// dropped Pro would answer with less thought than they asked for.
        let fastMode: Bool
        let proMode: Bool
        var userMessageID: String?
        var userCreatedAt: Date
    }

    public init(
        repository: Repository,
        outbox: any MutationOutboxRepository,
        drainer: NativeMutationDrainer<Repository>,
        syncModel: NativeSyncModel<Repository>,
        chatClient: NativeChatAPIClient? = nil,
        titleClient: NativeConversationTitleClient? = nil,
        opensMostRecentConversationOnLoad: Bool = true
    ) {
        store = NativeConversationStore(repository: repository, outbox: outbox)
        self.outbox = outbox
        self.drainer = drainer
        self.syncModel = syncModel
        self.chatClient = chatClient
        self.titleClient = titleClient
        self.opensMostRecentConversationOnLoad = opensMostRecentConversationOnLoad
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
        await refreshChatApprovals(includeRecent: true)
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
        chatApprovalsByConversation = [:]
        chatApprovalInFlightID = nil
        chatApprovalErrors = [:]
        chatApprovalScopeRefusals = []
        pendingMutationCount = 0
        conflictedMutationCount = 0
        lastErrorDescription = nil
        modelCatalog = []
        modelCatalogErrorDescription = nil
        chatPhase = .idle
        chatErrorDescription = nil
        activeChatConversationID = nil
        selectedConversationID = nil
        recentlyRenamedConversationID = nil
        titlePhasesRun = [:]
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
            if selectedConversationID == nil,
                !isDraftingNewConversation,
                opensMostRecentConversationOnLoad
            {
                selectedConversationID = conversations.first(where: { !$0.isArchived })?.id
            }
            lastErrorDescription = snapshot.conflictedMutationCount == 0
                ? nil : "A conversation change needs your attention."
            phase = syncModel.phase == .offline ? .offline : .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            phase = .failed
        }
    }

    @discardableResult
    public func createConversation(
        title: String = "New chat",
        model: String? = nil,
        projectID: String? = nil,
        kind: String = "chat"
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
            "kind": kind,
        ]
        if let model {
            let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedModel.isEmpty, trimmedModel.utf8.count <= 200 else {
                lastErrorDescription = NativeConversationStoreError.invalidModel.localizedDescription
                return nil
            }
            operation["model"] = trimmedModel
        }
        if let projectID {
            guard !projectID.isEmpty, projectID.utf8.count <= 200 else {
                lastErrorDescription = NativeConversationStoreError.invalidMutation.localizedDescription
                return nil
            }
            operation["projectId"] = projectID
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

    /// Creates a conversation and returns the id it settled on — the *server*
    /// id once the create drained, the client id while it is still queued.
    ///
    /// ``createConversation`` cannot answer that: the server mints its own id
    /// and the client id it was enqueued under stops existing the moment the
    /// mutation is acknowledged. A draft composer has to send into the row it
    /// just created, so it needs the id that survived, not the one it asked for.
    /// Resolved by diffing the conversation list across the create rather than
    /// by trusting the ordering, which a pinned conversation would break.
    /// - Parameter kind: `"code"` opens a Juno Code conversation instead of a
    ///   chat. It goes through this same path rather than a direct POST because
    ///   the create/settle race solved below is not specific to chats, and a
    ///   second implementation of it would be a second place to get it wrong.
    public func createConversationResolvingID(
        title: String = "New chat",
        model: String? = nil,
        projectID: String? = nil,
        kind: String = "chat"
    ) async -> String? {
        let before = Set(conversations.map(\.id))
        guard let clientID = await createConversation(
            title: title, model: model, projectID: projectID, kind: kind
        ) else { return nil }

        // The create drains and then pulls, but the pulled row can arrive a beat
        // after the local one is retired — leaving a window where neither id is
        // in the list. Two extra pulls close it. Without them the first send of a
        // new chat occasionally landed on a conversation the store had never
        // heard of, and the message stayed in the composer with no explanation.
        var created = conversations.filter { !before.contains($0.id) }
        for _ in 0..<2 where created.isEmpty {
            await syncModel.refresh()
            await reload()
            created = conversations.filter { !before.contains($0.id) }
        }

        // The settled server row is the one that is no longer pending. Falling
        // back to the client id keeps an offline create usable locally, where it
        // stays queued until the network returns.
        let resolved = created.first { !$0.isPending }?.id
            ?? created.max(by: { $0.createdAt < $1.createdAt })?.id
            ?? clientID
        isDraftingNewConversation = false
        selectedConversationID = resolved
        return resolved
    }

    /// Removes the conversation and its transcript, everywhere. Replaces archive
    /// as the destructive action offered on this client: archiving hid a
    /// conversation into a folder the phone has no screen for, which is
    /// indistinguishable from losing it.
    public func deleteConversation(id: String) async {
        let wasSelected = selectedConversationID == id
        await mutateExisting(
            id: id,
            operation: "conversation.delete",
            object: ["type": "conversation.delete", "entityId": id]
        )
        if wasSelected, selectedConversationID == id {
            selectedConversationID = nil
        }
        chatApprovalsByConversation.removeValue(forKey: id)
        titlePhasesRun[id] = nil
    }

    /// Asks the server to name the conversation, the way the web client does.
    ///
    /// Called twice per conversation: once with ``NativeConversationTitleClient/Phase/firstUser``
    /// when the question is sent, and once with `completed` when the answer
    /// lands — see ``titlePhasesRun``. The second pass is the one that names a
    /// chat from what it turned out to be *about* rather than from how it opened,
    /// and the app was missing it entirely.
    ///
    /// Best-effort throughout: the server owns the decision (a title the reader
    /// typed is never overwritten) and any failure is swallowed, because naming
    /// must never report an error on a message that sent fine.
    public func generateTitleIfNeeded(
        conversationID: String,
        phase: NativeConversationTitleClient.Phase = .firstUser
    ) async {
        guard let accountID, let titleClient,
            !(titlePhasesRun[conversationID]?.contains(phase) ?? false)
        else { return }
        let context = visibleMessages(for: conversationID)
            .filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .prefix(8)
            .map {
                NativeConversationTitleClient.ContextMessage(
                    role: $0.role == .user ? "USER" : "ASSISTANT",
                    content: $0.content
                )
            }
        guard context.contains(where: { $0.role == "USER" }) else { return }
        // The refining pass has nothing to refine *from* until an answer exists.
        if phase == .completed, !context.contains(where: { $0.role == "ASSISTANT" }) {
            return
        }
        titlePhasesRun[conversationID, default: []].insert(phase)

        let generated = try? await titleClient.generateTitle(
            conversationID: conversationID,
            phase: phase,
            messages: context,
            for: accountID
        )
        guard let generated, generated.renamed,
            self.accountID == accountID,
            let index = conversations.firstIndex(where: { $0.id == conversationID }),
            conversations[index].title != generated.title
        else { return }
        // Applied locally first so the rename lands the moment it is known; the
        // refresh below then persists the server's own row, and the two agree.
        conversations[index].title = generated.title
        recentlyRenamedConversationID = conversationID
        await syncModel.refresh()
        await reload()
    }

    /// Applies a rating to the on-screen row straight away.
    ///
    /// Optimistic on purpose: `POST /api/messages/:id/feedback` returns `{ok}`
    /// and nothing else worth waiting for, and a thumb that fills in a second
    /// after the tap reads as a button that did not work. The server's own value
    /// arrives with the next sync and overwrites this either way.
    public func applyFeedback(
        _ feedback: NativeChatFeedback?,
        messageID: String,
        conversationID: String
    ) {
        if let index = transientMessagesByConversation[conversationID]?
            .firstIndex(where: { $0.id == messageID })
        {
            transientMessagesByConversation[conversationID]?[index].feedback = feedback
        }
        if let index = messagesByConversation[conversationID]?
            .firstIndex(where: { $0.id == messageID })
        {
            messagesByConversation[conversationID]?[index].feedback = feedback
        }
    }

    /// Called by the screen that played the rename animation, so it plays once.
    public func acknowledgeTitleAnimation(for conversationID: String) {
        guard recentlyRenamedConversationID == conversationID else { return }
        recentlyRenamedConversationID = nil
    }

    public func renameConversation(id: String, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 200 else {
            lastErrorDescription = NativeConversationStoreError.invalidTitle.localizedDescription
            return
        }
        // A title the reader typed is theirs. Marking every phase run stops this
        // session's auto-namer from proposing one over the top of it — including
        // the refining pass that would otherwise fire when the next answer lands.
        titlePhasesRun[id] = Set(NativeConversationTitleClient.Phase.allCases)
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

    /// Associates the conversation with a project, or removes the association
    /// when `projectID` is nil. Reuses the server-validated `conversation.update`
    /// mutation (the server checks project ownership and accepts a null to clear).
    public func setProject(id: String, projectID: String?) async {
        if let projectID {
            guard !projectID.isEmpty, projectID.utf8.count <= 200 else {
                lastErrorDescription = NativeConversationStoreError.invalidMutation.localizedDescription
                return
            }
        }
        let patchValue: Any = projectID ?? NSNull()
        await mutateExisting(
            id: id,
            operation: "conversation.update",
            object: [
                "type": "conversation.update", "entityId": id,
                "patch": ["projectId": patchValue],
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

    /// The approvals relevant to one visible conversation, oldest first.
    public func chatApprovals(for conversationID: String) -> [NativeChatApproval] {
        chatApprovalsByConversation[conversationID] ?? []
    }

    public func chatApprovalError(for approvalID: String) -> String? {
        chatApprovalErrors[approvalID]
    }

    public func canAllowChatApprovalScope(_ approval: NativeChatApproval) -> Bool {
        approval.canAllowScope && !chatApprovalScopeRefusals.contains(approval.id)
    }

    /// Refreshes the receipt list for a cold launch, a selected conversation,
    /// or both. Errors are intentionally kept out of `chatErrorDescription`:
    /// inability to refresh a recovery card must not overwrite an unrelated
    /// streaming error or make an otherwise usable chat look failed.
    public func refreshChatApprovals(
        conversationID: String? = nil,
        includeRecent: Bool = true
    ) async {
        guard let accountID, let chatClient else { return }
        do {
            let approvals = try await chatClient.chatApprovals(
                conversationID: conversationID,
                includeRecent: includeRecent,
                for: accountID
            )
            guard self.accountID == accountID else { return }
            if let conversationID {
                mergeChatApprovals(approvals, into: conversationID)
            } else {
                let grouped = Dictionary(grouping: approvals) {
                    $0.conversationID ?? ""
                }
                for (conversationID, group) in grouped where !conversationID.isEmpty {
                    mergeChatApprovals(group, into: conversationID)
                }
            }
        } catch {
            // The live stream and the decision endpoint remain authoritative;
            // a recovery read is best effort while offline.
        }
    }

    /// Answers one chat approval and replaces the local receipt with the
    /// server's response. The digest check is performed by the API client before
    /// this update, so a stale card can never become a locally shown success.
    public func decideChatApproval(
        _ approval: NativeChatApproval,
        decision: NativeChatApprovalDecision
    ) async {
        guard approval.isPending,
            chatApprovalInFlightID == nil,
            let accountID,
            let chatClient
        else { return }
        chatApprovalInFlightID = approval.id
        chatApprovalErrors[approval.id] = nil
        defer {
            if chatApprovalInFlightID == approval.id {
                chatApprovalInFlightID = nil
            }
        }
        do {
            let decided = try await chatClient.decideChatApproval(
                approval,
                decision: decision,
                for: accountID
            )
            guard self.accountID == accountID else { return }
            upsertChatApproval(decided)
        } catch {
            guard self.accountID == accountID else { return }
            if let apiError = error as? NativeChatAPIError,
                case .server(_, let code, _, _) = apiError,
                code == "not_scope_allowable"
            {
                chatApprovalScopeRefusals.insert(approval.id)
            }
            chatApprovalErrors[approval.id] = presentChatApprovalError(error)
        }
    }

    public func reloadModelCatalog() async {
        guard let accountID, let chatClient else { return }
        do {
            let catalog = try await chatClient.modelCatalog(for: accountID)
            guard self.accountID == accountID else { return }
            modelCatalog = catalog.models.filter(\.isChatCapable)
            modelCatalogErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            modelCatalogErrorDescription = error.localizedDescription
        }
    }

    /// The modality this model generates, or nil when it is a chat model.
    ///
    /// Read from the catalog the server published. Nil is also the honest answer
    /// for a model this build has never heard of — an unknown model goes down the
    /// chat path, which is what every previous build did for every model.
    private func mediaModality(of modelID: String) -> NativeMediaProgress.Modality? {
        guard let model = modelCatalog.first(where: { $0.id == modelID }) else { return nil }
        return NativeMediaProgress.Modality(rawValue: model.modality)
    }

    @discardableResult
    public func sendMessage(
        conversationID: String,
        prompt: String,
        modelID: String,
        reasoningEffort: NativeReasoningEffort?,
        attachmentIDs: [String] = [],
        deepResearch: Bool = false,
        webSearch: Bool = false,
        canvasEnabled: Bool? = nil,
        connectors: [String] = [],
        // Defaulted so the call sites with no mode UI — JunoMacChatView's send
        // and the programmatic code-conversation start — keep compiling and keep
        // sending exactly the body they sent before.
        fastMode: Bool = false,
        proMode: Bool = false
    ) -> Bool {
        guard !chatPhase.isActive, let accountID, chatClient != nil,
            let conversation = conversations.first(where: { $0.id == conversationID }),
            !conversation.isPending
        else {
            chatErrorDescription = conversationPendingMessage(conversationID)
            return false
        }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        // Empty text is a real message when files came with it — "here, read
        // this" is the whole point of an attachment. This is the same rule
        // `/api/chat` applies (`!message?.trim() && attachmentIds.length === 0`),
        // and without it the composer's "Attach as file" produced a draft that
        // could no longer be sent.
        guard !trimmed.isEmpty || !attachmentIDs.isEmpty else {
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
            attachmentIDs: attachmentIDs,
            deepResearch: deepResearch,
            webSearch: webSearch,
            canvasEnabled: canvasEnabled,
            connectors: connectors,
            fastMode: fastMode,
            proMode: proMode,
            userMessageID: nil,
            userCreatedAt: now
        )
        retryContexts.removeValue(forKey: conversationID)
        researchActivity = []
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

    /// Starts a fresh turn that asks the model to continue a response it ended
    /// part-way through. This mirrors the web's continuation prompt: it keeps
    /// the partial answer visible and gives the provider a normal new user turn,
    /// rather than replaying the original prompt as Retry does.
    @discardableResult
    public func continueLastResponse(conversationID: String) -> Bool {
        guard canContinueSelectedConversation,
            let context = retryContexts[conversationID],
            accountID == context.accountID
        else { return false }

        return sendMessage(
            conversationID: conversationID,
            prompt: "Continue from where you left off.",
            modelID: context.modelID,
            reasoningEffort: context.reasoningEffort,
            deepResearch: context.deepResearch,
            webSearch: context.webSearch,
            canvasEnabled: context.canvasEnabled,
            connectors: context.connectors,
            fastMode: context.fastMode,
            proMode: context.proMode
        )
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
                    attachmentIDs: context.attachmentIDs,
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
            // WHICH ENDPOINT. An image or video model is not a chat model and
            // `/api/chat` cannot run one — which is why the picker's Image and
            // Video sections were selectable but inert until now. The modality
            // comes from the catalog rather than from the prompt or the model's
            // name, so a model added server-side routes correctly with no client
            // release.
            let events: AsyncThrowingStream<NativeChatServerEvent, any Error>
            if let modality = mediaModality(of: context.modelID) {
                events = try await chatClient.mediaGenerationEvents(
                    NativeMediaGenerationRequest(
                        conversationID: context.conversationID,
                        prompt: context.prompt,
                        modelID: context.modelID,
                        modality: modality
                    ),
                    for: context.accountID
                )
                // The placeholder exists from the first frame rather than from the
                // first `progress`: the queue wait before a provider answers is
                // the longest silence in the run, and it is exactly when a reader
                // decides the app is broken.
                updateMediaProgress(
                    NativeMediaProgress(modality: modality, stage: "queued", pct: nil),
                    conversationID: context.conversationID
                )
            } else {
                events = try await chatClient.generationEvents(
                    NativeChatGenerationRequest(
                        conversationID: context.conversationID,
                        modelID: context.modelID,
                        reasoningEffort: context.reasoningEffort,
                        generationID: generationID,
                        deepResearch: context.deepResearch,
                        webSearch: context.webSearch,
                        canvasEnabled: context.canvasEnabled,
                        connectors: context.connectors,
                        fastMode: context.fastMode,
                        proMode: context.proMode
                    ),
                    for: context.accountID
                )
            }
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
                case .activity(let activity):
                    recordActivity(activity, conversationID: context.conversationID)
                case .approval(let approval):
                    guard approval.conversationID == nil
                        || approval.conversationID == context.conversationID
                    else { throw NativeChatAPIError.malformedResponse }
                    upsertChatApproval(approval, conversationID: context.conversationID)
                case .mediaProgress(let progress):
                    // The one stage that is not a stage: `uploading` is Juno
                    // storing the finished file, so the picture already exists and
                    // the canvas should stop pretending to be making it. Every
                    // other stage keeps the placeholder alive.
                    updateMediaProgress(progress, conversationID: context.conversationID)
                    chatPhase = .streaming
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
            // The refining pass, after the reload so the answer it names the chat
            // from is actually in `visibleMessages`. The first-user pass ran when
            // the question was sent; this is the one that renames "Sidebar
            // question" to what the exchange turned out to be about, and it is
            // what the web's `completed` phase does. No-ops on a chat the reader
            // has named themselves.
            if chatPhase != .failed {
                await generateTitleIfNeeded(
                    conversationID: context.conversationID,
                    phase: .completed
                )
            }
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

    private func mergeChatApprovals(
        _ approvals: [NativeChatApproval],
        into conversationID: String
    ) {
        guard !conversationID.isEmpty else { return }
        var current = chatApprovalsByConversation[conversationID] ?? []
        for approval in approvals {
            guard approval.conversationID == nil
                || approval.conversationID == conversationID
            else { continue }
            if let index = current.firstIndex(where: { $0.id == approval.id }) {
                current[index] = approval
            } else {
                current.append(approval)
            }
            if approval.status != .pending {
                chatApprovalErrors[approval.id] = nil
            }
        }
        current.sort {
            $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
        }
        chatApprovalsByConversation[conversationID] = current
    }

    private func upsertChatApproval(
        _ approval: NativeChatApproval,
        conversationID: String? = nil
    ) {
        guard let conversationID = conversationID ?? approval.conversationID,
            !conversationID.isEmpty
        else { return }
        mergeChatApprovals([approval], into: conversationID)
    }

    private func presentChatApprovalError(_ error: Error) -> String {
        if let apiError = error as? NativeChatAPIError,
            case .server(_, let code, let message, _) = apiError
        {
            switch code {
            case "digest_mismatch":
                return "This approval no longer matches the action Juno showed. Nothing was sent."
            case "policy_changed":
                return "Your permissions changed, so Juno refused this approval. Nothing was sent."
            case "expired":
                return "This approval expired before it was answered. Nothing was sent."
            case "already_decided":
                return "This approval was already answered, possibly on another device."
            case "not_scope_allowable":
                return "Juno cannot remember this permission. Allow once or deny it."
            case "blocked":
                return "Your permissions blocked this action. Nothing was sent."
            default:
                return message
            }
        }
        return error.localizedDescription
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
            // An unknown id is only tolerated when the catalog never loaded —
            // otherwise the server has told us this model does not exist.
            return modelCatalog.isEmpty
        }
        // The catalog now carries plan-gated and coming-soon models so they can
        // be explained in the picker; they are still never sendable.
        guard model.isAvailable else { return false }
        // Auto routes its own thinking: an effort sent alongside it would be
        // silently discarded by the server, so refuse it here instead.
        guard !model.choosesReasoningAutomatically else { return effort == nil }
        // On/off models publish no tiers; the route reads `high` as "on" for
        // them, so that is the one effort they accept.
        if model.isOnOffReasoningOnly {
            guard let effort else { return model.canDisableReasoning }
            return effort == .high
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
            lastErrorDescription = NativeFailureMessage.presentable(error)
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
            lastErrorDescription = NativeFailureMessage.presentable(error)
            // Draining is a network call, so losing connectivity here is an
            // outage, not a refusal. Reporting it as `.failed` told the reader
            // their queued changes had hard-failed when they were still safely
            // queued and would go out on reconnect.
            phase = NativeSyncModel<Repository>.isConnectivityFailure(error)
                || syncModel.phase == .offline
                ? .offline
                : .failed
        }
    }

    /// Resolves every conflicted conversation mutation at once: retry replays
    /// the local change against the freshly synced revision, discard keeps the
    /// server version and drops the local edit.
    public func resolveConflicts(keepLocalChanges: Bool) async {
        guard let accountID else { return }
        if keepLocalChanges { await syncModel.refresh() }
        do {
            let storageAccountID = StorageAccountID(accountID.rawValue)
            let mutations = try await outbox.mutations(accountID: storageAccountID)
            for mutation in mutations
                where mutation.draft.entity.namespace == "conversation"
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
            lastErrorDescription = NativeFailureMessage.presentable(error)
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
    let projectId: String?
}

private struct MessageWire: Decodable {
    let id: String
    let conversationId: String
    let clientId: String?
    let role: String
    let content: String
    let reasoning: String?
    let model: String?
    /// Integer micro-USD, as the column stores it. Optional because every
    /// message written before the column existed has none, and because a user
    /// turn never has one.
    let costMicroUsd: Int?
    let feedback: String?
    let createdAt: String
}

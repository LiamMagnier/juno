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
    /// The turn's token receipt, as the server persisted it.
    ///
    /// These arrive on the `message` sync entity, which is what makes a session
    /// receipt survive a relaunch: before the columns existed the split lived
    /// only on the live `done` frame, so a reloaded transcript could never show
    /// a cache hit. Every one is nil on a user turn, on a row written before the
    /// columns, and on a provider that reports no cache buckets — three distinct
    /// reasons that all mean UNKNOWN. None of them mean zero.
    public var promptTokens: Int?
    public var completionTokens: Int?
    public var cacheReadTokens: Int?
    public var cacheWriteTokens: Int?
    /// The reader's rating, as the server holds it.
    public var feedback: NativeChatFeedback?
    /// Live media-generation progress, while `/api/generate` runs.
    ///
    /// Client-transient and never persisted — exactly as `progress` is on the
    /// web's message model. It exists only between the request and the `done`
    /// frame that replaces this row with the finished message, and a value that
    /// survived a reload would be claiming a generation that is not running.
    public var mediaProgress: NativeMediaProgress?
    /// The files that travel with this message — the reader's photos on a
    /// question, the generated picture on an answer. Joined from the
    /// `attachment` sync entity by ``NativeConversationStore``; empty on every
    /// message that has none, and on a streamed placeholder until the server's
    /// row replaces it.
    public var attachments: [NativeChatAttachment]

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
        promptTokens: Int? = nil,
        completionTokens: Int? = nil,
        cacheReadTokens: Int? = nil,
        cacheWriteTokens: Int? = nil,
        feedback: NativeChatFeedback? = nil,
        mediaProgress: NativeMediaProgress? = nil,
        attachments: [NativeChatAttachment] = []
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
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.mediaProgress = mediaProgress
        self.feedback = feedback
        self.attachments = attachments
    }

    /// The pictures on this message, in the order they were attached.
    public var imageAttachments: [NativeChatAttachment] { attachments.filter(\.isImage) }
}

public struct NativeConversationSnapshot: Equatable, Sendable {
    public let conversations: [NativeConversation]
    public let messagesByConversation: [String: [NativeChatMessage]]
    public let pendingMutationCount: Int
    public let conflictedMutationCount: Int
    /// The branch topology, grouped by conversation.
    ///
    /// A conversation missing from this map has never been branched — which is
    /// every conversation the server has ever sent, since the backend keeps
    /// message *versions* and has no parent link to send. Missing therefore
    /// means "plain linear transcript", and the projection renders it exactly as
    /// this app did before trees existed. It never means "topology unknown".
    ///
    /// Defaulted in the initializer so callers written before branching still
    /// compile and still describe the truth: they build unbranched snapshots.
    public let branchLinksByConversation: [String: [MessageBranchLink]]

    public init(
        conversations: [NativeConversation],
        messagesByConversation: [String: [NativeChatMessage]],
        pendingMutationCount: Int,
        conflictedMutationCount: Int,
        branchLinksByConversation: [String: [MessageBranchLink]] = [:]
    ) {
        self.conversations = conversations
        self.messagesByConversation = messagesByConversation
        self.pendingMutationCount = pendingMutationCount
        self.conflictedMutationCount = conflictedMutationCount
        self.branchLinksByConversation = branchLinksByConversation
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
    /// Raised when a fork is attempted on something that cannot be re-asked —
    /// an assistant answer, or a question that has not finished sending.
    case messageNotEditable(String)

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
        case .messageNotEditable:
            "Only a message you sent, and that finished sending, can be edited."
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
        var attachmentsByMessage: [String: [NativeChatAttachment]] = [:]

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
            case "attachment":
                // Lenient on purpose: an attachment row this store cannot
                // read must not take the whole transcript down with it. The
                // project store is the one that fails closed on these.
                if let (messageID, attachment) = decodeAttachment(record) {
                    attachmentsByMessage[messageID, default: []].append(attachment)
                }
            default:
                break
            }
        }

        if !attachmentsByMessage.isEmpty {
            for (conversationID, rows) in messages {
                messages[conversationID] = rows.map { message in
                    guard let joined = attachmentsByMessage[message.id] else { return message }
                    var message = message
                    message.attachments = joined.sorted { $0.id < $1.id }
                    return message
                }
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
        let branchLinks = try await reconciledBranchLinks(
            accountID: accountID,
            messagesByConversation: orderedMessages
        )
        return NativeConversationSnapshot(
            conversations: orderedConversations,
            messagesByConversation: orderedMessages,
            pendingMutationCount: pendingCount,
            conflictedMutationCount: conflictCount,
            branchLinksByConversation: branchLinks
        )
    }

    // MARK: - Branch topology

    /// Reads the account's branch edges and, for conversations that already have
    /// some, places any message the tree has not seen yet.
    ///
    /// **Why a read does a write.** A message can only be attached to the right
    /// parent at the moment it arrives, because the parent is "the tip of the
    /// path the reader is on" and that is a fact about *now*: once the reader
    /// switches branches the answer changes, and once they switch twice it is
    /// unrecoverable. Deferring the write to the next explicit user action would
    /// mean a sync that landed while the app was backgrounded could be attached
    /// to whatever branch happened to be active when they next opened it, and
    /// the reply would appear under a question that never asked it.
    ///
    /// The pass is free for anyone who has never edited a message: an account
    /// with no edges loads zero rows and writes none, and a conversation that
    /// has never branched is skipped by `reconciliationLinks` returning empty.
    private func reconciledBranchLinks(
        accountID: StorageAccountID,
        messagesByConversation: [String: [NativeChatMessage]]
    ) async throws -> [String: [MessageBranchLink]] {
        let stored = try await repository.messageBranchLinks(for: accountID)
        guard !stored.isEmpty else { return [:] }

        var grouped = Dictionary(grouping: stored, by: \.conversationID)
        var repairs: [MessageBranchLink] = []
        let now = Date()
        for (conversationID, links) in grouped {
            let created = NativeConversationTreeProjection.reconciliationLinks(
                conversationID: conversationID,
                messages: messagesByConversation[conversationID] ?? [],
                links: links,
                now: now
            )
            guard !created.isEmpty else { continue }
            repairs.append(contentsOf: created)
            grouped[conversationID] = links + created
        }
        if !repairs.isEmpty {
            try await repository.recordMessageBranchLinks(repairs, for: accountID)
        }
        return grouped
    }

    /// Records the linear spine of a conversation that is about to be forked,
    /// and returns the topology it now has.
    ///
    /// Called immediately before the first edit of a conversation. Laying the
    /// spine down is what turns "no rows, therefore linear" into an explicit
    /// tree the fork can hang a sibling off — and because the spine describes
    /// the transcript exactly as it already reads, recording it changes nothing
    /// the reader can see.
    public func prepareBranchPoint(
        accountID: StorageAccountID,
        conversationID: String,
        messages: [NativeChatMessage]
    ) async throws -> [MessageBranchLink] {
        let existing = try await repository.messageBranchLinks(for: accountID)
            .filter { $0.conversationID == conversationID }
        guard existing.isEmpty else { return existing }
        let spine = NativeConversationTreeProjection.spineLinks(
            conversationID: conversationID,
            messages: messages,
            now: Date()
        )
        guard !spine.isEmpty else { return [] }
        try await repository.recordMessageBranchLinks(spine, for: accountID)
        return spine
    }

    /// Adds one child under `parentMessageID` and makes it the active sibling.
    ///
    /// `branchIndex` is taken from the count of siblings already recorded rather
    /// than from the caller, so two edits racing on the same parent cannot both
    /// claim position 1 and leave the pager numbering two different revisions
    /// the same.
    public func recordBranch(
        accountID: StorageAccountID,
        conversationID: String,
        messageID: String,
        parentMessageID: String?
    ) async throws {
        let siblings = try await repository.messageBranchLinks(for: accountID)
            .filter {
                $0.conversationID == conversationID
                    && $0.parentMessageID == parentMessageID
                    && $0.messageID != messageID
            }
        try await repository.recordMessageBranchLinks(
            [
                MessageBranchLink(
                    conversationID: conversationID,
                    messageID: messageID,
                    parentMessageID: parentMessageID,
                    branchIndex: siblings.count,
                    isActiveBranch: true,
                    createdAt: Date()
                )
            ],
            for: accountID
        )
    }

    /// Switches the active sibling. Returns false when the message has no
    /// recorded place in a tree — nothing was switched, and the caller must not
    /// redraw as though something had been.
    @discardableResult
    public func activateBranch(
        accountID: StorageAccountID,
        messageID: String
    ) async throws -> Bool {
        try await repository.activateMessageBranch(messageID: messageID, for: accountID)
    }

    /// Drops a deleted conversation's topology, so its edges cannot outlive it.
    public func removeBranchLinks(
        accountID: StorageAccountID,
        conversationID: String
    ) async throws {
        try await repository.removeMessageBranchLinks(
            conversationID: conversationID,
            for: accountID
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

    /// An attachment that belongs to a message, or nil for one that does not —
    /// a project file, a library upload — or that cannot be read.
    private func decodeAttachment(_ record: StoredRecord) -> (String, NativeChatAttachment)? {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(MessageAttachmentWire.self, from: payload),
            wire.id == record.key.id,
            let messageID = wire.messageId, !messageID.isEmpty,
            !wire.fileName.isEmpty, !wire.mimeType.isEmpty
        else { return nil }
        return (
            messageID,
            NativeChatAttachment(
                id: wire.id,
                fileName: wire.fileName,
                mimeType: wire.mimeType,
                kind: wire.kind,
                size: wire.size ?? 0,
                width: wire.width,
                height: wire.height
            )
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
            // Carried through exactly as sent. Unlike `costUSD` above, a zero is
            // NOT folded into nil here: the server writes these only when the
            // provider reported them, so a 0 means "measured, and it was zero"
            // — a real cache miss, which is a different fact from "never told".
            promptTokens: wire.promptTokens,
            completionTokens: wire.completionTokens,
            cacheReadTokens: wire.cacheReadTokens,
            cacheWriteTokens: wire.cacheWriteTokens,
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

/// A turn that has actually finished, as anything reading conversations after the
/// fact needs it.
///
/// Handed to ``NativeConversationModel/didFinishTurn`` rather than letting the
/// observer reach back into the model, which is what keeps the two privacy rules
/// enforceable in one place instead of at every call site.
public struct NativeFinishedTurn: Equatable, Sendable {
    public let conversationID: String

    /// **The reader's own turns, and only those.**
    ///
    /// The model's replies are not merely filtered later, they are never put in
    /// here. A memory extracted from "so you prefer dark roast" is the model's own
    /// guess promoted to a stored fact about the reader, and from then on it is
    /// reciting its own hallucination back as something they told it.
    public let userTurns: [MemoryExtractionTurn]

    /// False when this conversation's project withholds
    /// ``ProjectWorkspaceTool/memoryRecall``.
    ///
    /// A persona that is not told what the account remembers must not be a way of
    /// *adding* to it either. Withholding recall while still learning would make
    /// the whitelist a one-way valve into a store the assistant is not allowed to
    /// read — the reader would see facts appear from an assistant they had walled
    /// off from memory entirely.
    public let mayLearn: Bool

    public init(
        conversationID: String,
        userTurns: [MemoryExtractionTurn],
        mayLearn: Bool
    ) {
        self.conversationID = conversationID
        self.userTurns = userTurns
        self.mayLearn = mayLearn
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

    // MARK: - Custom assistants and memory
    //
    // Two hooks, both optional, both left nil by every caller that does not use
    // them — a client with neither behaves exactly as it did before these
    // existed. They are here rather than in the two chat screens because there
    // are two chat screens: the Mac's and the phone's. A hook wired once in the
    // model is a guarantee; a hook wired twice in two views is a thing that is
    // true on one platform.

    /// Applies a project's tool whitelist to a turn, immediately before it is
    /// sent.
    ///
    /// **This is where a whitelist stops being advice.** A restriction encoded as
    /// prose in the project's instructions is one the model can decline to honour;
    /// this is the client declining to send the flag at all, which is the only
    /// version of a whitelist that is a gate. Wired to
    /// ``ProjectWorkspaceConfiguration/permitting(_:)`` by the app; nil means no
    /// custom assistants are configured on this device and every turn goes out as
    /// the composer built it.
    ///
    /// Consulted only for conversations that belong to a project — plain Juno has
    /// no persona and therefore nothing to be restricted by.
    public var workspacePermissions: (
        @MainActor (_ projectID: String, _ requested: ProjectWorkspaceTurnPermissions)
            -> ProjectWorkspaceTurnPermissions
    )?

    /// Called once a turn has finalized and the transcript has been reloaded.
    ///
    /// The post-turn seam ``MemoryLearningModel`` needs, and the reason it is here:
    /// only this object knows when a turn is genuinely *finished* — a stream that
    /// ended in `.failed`, was cancelled, or is mid-reconnect has not finished, and
    /// learning from one would file half a sentence.
    public var didFinishTurn: (@MainActor (NativeFinishedTurn) -> Void)?

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

    /// What each conversation has cost, keyed by conversation.
    ///
    /// Per-conversation rather than one running total: the badge sits in a
    /// conversation's own header, and a reader switching chats must not see the
    /// previous one's spend attributed to this one.
    ///
    /// Rebuilt on every reload from the persisted rows (see
    /// ``seedSessionCostLedgers(from:)``) and corrected live from each `done`
    /// frame. It was session-scoped until `Message` gained cache columns, for
    /// the good reason that a reloaded transcript carried no split to show;
    /// that limitation is gone. Still a per-conversation receipt rather than a
    /// billing record — `NativeUsageBreakdown` remains the account's durable
    /// history and the place to ask what a month cost.
    private var sessionCostLedgers: [String: SessionCostLedger] = [:]

    /// The receipt for a given conversation, empty when it has not answered yet.
    public func sessionCost(for conversationID: String) -> NativeSessionCostTotals {
        sessionCostLedgers[conversationID]?.totals ?? .empty
    }

    /// Rebuilds each conversation's receipt from what the server persisted.
    ///
    /// This is what makes the badge survive a relaunch. It became possible only
    /// once `Message` gained `cacheReadTokens`/`cacheWriteTokens` and the sync
    /// entity started carrying them; before that a reloaded transcript had no
    /// split to show and the ledger was necessarily session-scoped.
    ///
    /// Safe to run on every reload because ``SessionCostLedger/record(_:)``
    /// replaces by message id rather than appending. A turn already recorded
    /// live from its `done` frame is corrected by the persisted row, not billed
    /// a second time — and the persisted row is the authoritative one, since it
    /// is what the server actually wrote.
    ///
    /// A turn the server reported nothing for is skipped entirely rather than
    /// recorded as a zero: it must keep counting as "unknown" in
    /// `turnsReportingCost`, which is what puts the "≥" in front of the total.
    private func seedSessionCostLedgers(
        from messages: [String: [NativeChatMessage]]
    ) {
        for (conversationID, rows) in messages {
            var ledger = sessionCostLedgers[conversationID] ?? SessionCostLedger()
            for row in rows where row.role == .assistant {
                guard row.costUSD != nil
                    || row.promptTokens != nil
                    || row.completionTokens != nil
                    || row.cacheReadTokens != nil
                    || row.cacheWriteTokens != nil
                else { continue }
                ledger.record(NativeTurnUsage(
                    messageID: row.id,
                    model: row.model,
                    promptTokens: row.promptTokens,
                    completionTokens: row.completionTokens,
                    cacheReadTokens: row.cacheReadTokens,
                    cacheWriteTokens: row.cacheWriteTokens,
                    costUsd: row.costUSD,
                    recordedAt: row.createdAt
                ))
            }
            // Only keep a ledger that actually has something in it, so an empty
            // conversation still reports `.empty` and the badge stays hidden.
            if !ledger.turns.isEmpty { sessionCostLedgers[conversationID] = ledger }
        }
    }

    /// The receipt for whatever conversation is on screen.
    public var selectedSessionCost: NativeSessionCostTotals {
        guard let selectedConversationID else { return .empty }
        return sessionCost(for: selectedConversationID)
    }

    /// Per-model subtotals for the selected conversation, heaviest spend first.
    public var selectedSessionCostByModel: [(model: String?, totals: NativeSessionCostTotals)] {
        guard let selectedConversationID,
              let ledger = sessionCostLedgers[selectedConversationID]
        else { return [] }
        return ledger.totalsByModel()
    }
    private var generationTask: Task<Void, Never>?
    private var activeGenerationID: String?
    private var chatApprovalErrors: [String: String] = [:]
    private var chatApprovalScopeRefusals = Set<String>()

    /// The projected tree per conversation, rebuilt on every reload.
    ///
    /// Cached rather than recomputed inside ``visibleMessages(for:)`` because
    /// that accessor is read once per SwiftUI body evaluation, and a tree walk
    /// per frame would turn a long transcript into a scroll stutter. A
    /// conversation absent from this map has no recorded topology, which is the
    /// normal state and is rendered as a plain line.
    private var branchTreesByConversation: [String: NativeConversationTree] = [:]

    /// While an edit's answer is streaming, the ids of the path it replaces.
    ///
    /// The rows are **not** deleted — they are the branch the reader can step
    /// back to the moment the pager appears. This set only stops the screen from
    /// showing the old answer underneath the new question during the seconds
    /// between sending the edit and the reload that makes the new branch active.
    /// Keyed by conversation and cleared by that reload.
    private var branchEditCutoffs: [String: Set<String>] = [:]

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
        /// `var` for one caller: ``retryLastMessage(conversationID:modelID:)``,
        /// the action row's "Switch model" regenerate, which re-asks the same
        /// prompt of a different model. Everything else on the context is what
        /// the reader asked for and travels unchanged.
        var modelID: String
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
        /// Set only when this turn is a *fork*: the message it branches away
        /// from, and the parent both revisions will hang under.
        ///
        /// Carried on the retry context rather than held in a side table so a
        /// retried edit lands on the same parent as the first attempt. Without
        /// it, retrying a failed fork would append the new wording to the tip of
        /// whatever branch was active, silently turning a revision into a reply.
        let branchPlacement: BranchPlacement?
        var userMessageID: String?
        var userCreatedAt: Date
    }

    /// Where a forked turn belongs in the tree.
    private struct BranchPlacement: Sendable {
        /// The message the reader edited. Its own parent becomes the fork point,
        /// because a revision is a *sibling* of the original, never its child.
        let replacedMessageID: String
        /// The shared parent. Nil is a real value here: editing the first thing
        /// ever said in a conversation forks at the root, and the two revisions
        /// are both roots.
        let parentMessageID: String?
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
        branchTreesByConversation = [:]
        branchEditCutoffs = [:]
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
            seedSessionCostLedgers(from: snapshot.messagesByConversation)
            rebuildBranchTrees(from: snapshot)
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
        branchEditCutoffs.removeValue(forKey: id)
        branchTreesByConversation.removeValue(forKey: id)
        // Branch edges are client-owned and are not carried by the delete
        // mutation, so nothing else will ever remove them. Left behind they
        // would re-attach to any future message that reused an id — a tree
        // grafted onto a stranger's transcript.
        if let accountID {
            try? await store.removeBranchLinks(
                accountID: StorageAccountID(accountID.rawValue),
                conversationID: id
            )
        }
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

    /// The permissions a turn in this conversation may actually be sent with.
    ///
    /// A conversation outside a project is plain Juno and comes back untouched —
    /// not "restricted to nothing", which is what a default-deny would make of
    /// every chat on a device that happens to have one custom assistant on it.
    private func permitting(
        _ requested: ProjectWorkspaceTurnPermissions,
        conversationID: String
    ) -> ProjectWorkspaceTurnPermissions {
        guard let filter = workspacePermissions,
            let projectID = conversations.first(where: { $0.id == conversationID })?.projectId,
            !projectID.isEmpty
        else { return requested }
        return filter(projectID, requested)
    }

    /// The reader's side of a conversation, as the memory extractor takes it.
    ///
    /// Bounded to the tail rather than the whole transcript. The extractor is
    /// re-run after every finished turn, so an unbounded projection would re-read
    /// a three-hundred-message chat on each reply — work that grows with the
    /// square of the conversation for candidates that were deduplicated against
    /// the store the first fifty times. The tail is also where anything new was
    /// said; nothing earlier can have changed since the previous pass.
    private func memoryExtractionTurns(for conversationID: String) -> [MemoryExtractionTurn] {
        visibleMessages(for: conversationID)
            .suffix(Self.memoryExtractionWindow)
            .filter { $0.role == .user && !$0.isPending && $0.errorDescription == nil }
            .map { MemoryExtractionTurn(role: .user, text: $0.content) }
    }

    /// How much of a transcript one pass reads. Twenty messages is several turns
    /// of context and a bounded amount of work.
    private static var memoryExtractionWindow: Int { 20 }

    /// Tells ``didFinishTurn`` about a turn that genuinely completed.
    ///
    /// Guarded on `chatPhase != .failed` by the caller: a stream that errored, was
    /// stopped, or is reconnecting has not produced a finished turn, and extracting
    /// from one would learn from a half-written message.
    private func announceFinishedTurn(conversationID: String) {
        guard let didFinishTurn else { return }
        let turns = memoryExtractionTurns(for: conversationID)
        guard !turns.isEmpty else { return }
        // `permitting` answers the whitelist question for this conversation's
        // project, so the observer never has to know what a project is.
        let mayLearn = permitting(
            ProjectWorkspaceTurnPermissions(memoryRecall: true),
            conversationID: conversationID
        ).memoryRecall
        didFinishTurn(
            NativeFinishedTurn(
                conversationID: conversationID,
                userTurns: turns,
                mayLearn: mayLearn
            )
        )
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
        sendMessage(
            conversationID: conversationID,
            prompt: prompt,
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            attachmentIDs: attachmentIDs,
            deepResearch: deepResearch,
            webSearch: webSearch,
            canvasEnabled: canvasEnabled,
            connectors: connectors,
            fastMode: fastMode,
            proMode: proMode,
            branchPlacement: nil
        )
    }

    /// The one implementation. The public entry point above forwards with no
    /// placement — an ordinary turn extends the active path and needs no edge of
    /// its own, because reconciliation attaches it to the tip on the next load.
    /// Only a fork knows something reconciliation cannot work out for itself.
    @discardableResult
    private func sendMessage(
        conversationID: String,
        prompt: String,
        modelID: String,
        reasoningEffort: NativeReasoningEffort?,
        attachmentIDs: [String],
        deepResearch: Bool,
        webSearch: Bool,
        canvasEnabled: Bool?,
        connectors: [String],
        fastMode: Bool,
        proMode: Bool,
        branchPlacement: BranchPlacement?
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
        // The whitelist, applied to the actual request rather than described in
        // the prompt. Vetoes only — see
        // ``ProjectWorkspaceConfiguration/permitting(_:)``, which cannot grant a
        // capability the composer did not already ask for.
        let permitted = permitting(
            ProjectWorkspaceTurnPermissions(
                webSearch: webSearch,
                deepResearch: deepResearch,
                canvasEnabled: canvasEnabled,
                connectorIDs: connectors,
                mediaGeneration: mediaModality(of: modelID) != nil,
                memoryRecall: true
            ),
            conversationID: conversationID
        )
        // An image or video model *is* the capability, so a workspace that denies
        // it cannot be honoured by stripping a flag — there is no flag, the model
        // id is the request. Refusing with a reason is the only honest answer;
        // silently routing to a chat model would answer a different question than
        // the one that was asked.
        guard permitted.mediaGeneration || mediaModality(of: modelID) == nil else {
            chatErrorDescription =
                "This assistant is not allowed to generate images or video. Choose a different model, or allow it in the project's Assistant settings."
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
            deepResearch: permitted.deepResearch,
            webSearch: permitted.webSearch,
            canvasEnabled: permitted.canvasEnabled,
            connectors: permitted.connectorIDs,
            fastMode: fastMode,
            proMode: proMode,
            branchPlacement: branchPlacement,
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
        retryLastMessage(conversationID: conversationID, modelID: nil)
    }

    /// Re-asks the last prompt, optionally of a different model.
    ///
    /// The web's regenerate menu — "Try again" and a "Switch model" submenu —
    /// both land here. A model that is not in the account's catalog is refused
    /// the same way ``sendMessage`` refuses it, so the row cannot re-ask a
    /// question of something the account cannot use. The new model is written
    /// back into the retry context, so a *further* retry keeps the switch.
    public func retryLastMessage(conversationID: String, modelID: String?) {
        guard !chatPhase.isActive, var context = retryContexts[conversationID],
            accountID == context.accountID
        else { return }
        if let modelID, modelID != context.modelID {
            guard validModelSelection(modelID, effort: context.reasoningEffort) else { return }
            context.modelID = modelID
            retryContexts[conversationID] = context
            if let index = conversations.firstIndex(where: { $0.id == conversationID }) {
                conversations[index].model = modelID
            }
        }
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
                // The edge is written the moment the server hands back the real
                // id and *before* the answer starts, so a stream that dies
                // mid-generation still leaves the revision recorded and
                // reachable from the pager. Written after the append rather than
                // before it because there is no id to link until then.
                await recordBranchLink(for: context, userMessageID: appended.id)
                guard accountID == context.accountID else { return }
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
                // After the reload, for the same reason the title pass is: the
                // turn the extractor reads has to actually be in
                // `visibleMessages`. Before this call there was no moment in the
                // whole client at which anything looked at a finished
                // conversation, which is why `MemoryExtractionEngine` had no
                // caller at all.
                announceFinishedTurn(conversationID: context.conversationID)
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
        // The receipt is recorded HERE, off the live `done` frame, and nowhere
        // else. The prompt-cache split exists only on this frame — `Message` has
        // no column for it — so a ledger built from reloaded rows could never
        // show a cache hit. Recording at the same instant the answer completes is
        // what makes the badge's cache figures possible at all.
        sessionCostLedgers[conversationID, default: SessionCostLedger()]
            .record(message: message)
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

    /// Recomputes the projected timeline for every conversation that has one.
    ///
    /// Conversations with no recorded edges are deliberately left out of the
    /// map rather than given an all-linear tree: absent means "never branched",
    /// and ``visibleMessages(for:)`` then takes the untouched pre-branching path
    /// for them — the same array, in the same order, with no walk in between.
    private func rebuildBranchTrees(from snapshot: NativeConversationSnapshot) {
        var trees: [String: NativeConversationTree] = [:]
        for (conversationID, links) in snapshot.branchLinksByConversation
        where !links.isEmpty {
            trees[conversationID] = NativeConversationTreeProjection.project(
                messages: snapshot.messagesByConversation[conversationID] ?? [],
                links: links
            )
        }
        branchTreesByConversation = trees
        // A cutoff describes a fork whose replacement has not landed yet. Once
        // the reload brings back a tree where the edited message is no longer on
        // the active path, the tree itself is hiding that branch and the cutoff
        // would only be hiding it twice — including, eventually, after the
        // reader steps back to it.
        for (conversationID, hidden) in branchEditCutoffs {
            guard let tree = trees[conversationID] else { continue }
            let stillActive = Set(tree.timeline.map(\.id))
            if hidden.isDisjoint(with: stillActive) {
                branchEditCutoffs.removeValue(forKey: conversationID)
            }
        }
    }

    /// Where `messageID` sits among its alternatives, or nil when it has none.
    ///
    /// Nil is the answer for every message in an unbranched conversation, which
    /// is what keeps the `‹ 1 / 1 ›` pager — a control that cannot do anything —
    /// off the overwhelming majority of transcripts.
    public func branchPosition(
        for messageID: String,
        in conversationID: String
    ) -> NativeMessageBranchPosition? {
        guard let position = branchTreesByConversation[conversationID]?
            .positions[messageID], position.hasAlternatives
        else { return nil }
        return position
    }

    /// Switches the conversation to the sibling `offset` steps from the one
    /// shown, and reloads the timeline projection.
    ///
    /// No-ops at either end rather than wrapping, and no-ops entirely while a
    /// generation is running: switching branches mid-stream would leave the
    /// answer being written attached to a question no longer on screen.
    public func stepBranch(
        from messageID: String,
        in conversationID: String,
        offset: Int
    ) async {
        guard !chatPhase.isActive,
            let position = branchPosition(for: messageID, in: conversationID),
            let target = position.siblingID(steppedBy: offset)
        else { return }
        await selectBranch(messageID: target, in: conversationID)
    }

    /// Makes `messageID` the revision the active timeline walks into.
    public func selectBranch(messageID: String, in conversationID: String) async {
        guard !chatPhase.isActive, let accountID else { return }
        do {
            let switched = try await store.activateBranch(
                accountID: StorageAccountID(accountID.rawValue),
                messageID: messageID
            )
            guard switched else { return }
            // The edit cutoff described the branch being replaced. An explicit
            // switch is the reader saying which branch they want, so a stale
            // cutoff must not keep hiding the one they just asked for.
            branchEditCutoffs.removeValue(forKey: conversationID)
            await reload()
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    /// Rewrites a historical user message as a **new branch** and asks for a
    /// fresh answer along it.
    ///
    /// Nothing is overwritten and nothing is deleted. The original message keeps
    /// its id, its content and its whole subtree of replies; the new wording is
    /// recorded as its *sibling*, and the pager under the message is what takes
    /// the reader back. This is the difference from the website's edit, which
    /// PATCHes the row in place and keeps only the previous text as a
    /// `MessageVersion` — there, the answers that followed the old wording are
    /// gone from the transcript for good.
    ///
    /// - Returns: false when the edit could not be started, with
    ///   ``chatErrorDescription`` explaining why.
    @discardableResult
    public func editUserMessage(
        messageID: String,
        conversationID: String,
        newContent: String,
        modelID: String,
        reasoningEffort: NativeReasoningEffort? = nil,
        attachmentIDs: [String] = [],
        deepResearch: Bool = false,
        webSearch: Bool = false,
        canvasEnabled: Bool? = nil,
        connectors: [String] = [],
        fastMode: Bool = false,
        proMode: Bool = false
    ) async -> Bool {
        guard !chatPhase.isActive, let accountID else { return false }
        guard let original = (messagesByConversation[conversationID] ?? [])
            .first(where: { $0.id == messageID })
        else {
            chatErrorDescription = conversationPendingMessage(conversationID)
            return false
        }
        // Only a question can be re-asked. Editing an answer would ask the model
        // to have said something it did not say, and every reply below it would
        // then be a response to words that were never generated.
        guard original.role == .user, !original.isPending else {
            chatErrorDescription = NativeConversationStoreError
                .messageNotEditable(messageID).localizedDescription
            return false
        }

        let storageAccountID = StorageAccountID(accountID.rawValue)
        let links: [MessageBranchLink]
        do {
            links = try await store.prepareBranchPoint(
                accountID: storageAccountID,
                conversationID: conversationID,
                messages: messagesByConversation[conversationID] ?? []
            )
        } catch {
            guard self.accountID == accountID else { return false }
            chatErrorDescription = NativeFailureMessage.presentable(error)
            return false
        }
        guard self.accountID == accountID else { return false }

        // The fork point is the edited message's *parent*, so the revision is a
        // sibling. Falling back to nil here is correct rather than defensive:
        // a message with no recorded parent after the spine was laid down is the
        // conversation's first message, and its revisions are roots too.
        let placement = BranchPlacement(
            replacedMessageID: messageID,
            parentMessageID: links.first { $0.messageID == messageID }?.parentMessageID
        )

        // Hide the path this edit replaces while the new answer streams. The
        // rows stay in the store — this is a view filter, not a delete.
        let timeline = branchTreesByConversation[conversationID]?.timeline
            ?? messagesByConversation[conversationID]
            ?? []
        branchEditCutoffs[conversationID] = NativeConversationTreeProjection
            .activeSuffix(from: messageID, timeline: timeline)

        let sent = sendMessage(
            conversationID: conversationID,
            prompt: newContent,
            modelID: modelID,
            reasoningEffort: reasoningEffort,
            attachmentIDs: attachmentIDs,
            deepResearch: deepResearch,
            webSearch: webSearch,
            canvasEnabled: canvasEnabled,
            connectors: connectors,
            fastMode: fastMode,
            proMode: proMode,
            branchPlacement: placement
        )
        if !sent {
            // The turn never left, so the path it was going to replace must come
            // straight back. Leaving the cutoff behind would hide a live branch
            // on the strength of an edit that did not happen.
            branchEditCutoffs.removeValue(forKey: conversationID)
        }
        return sent
    }

    private func recordBranchLink(
        for context: RetryContext,
        userMessageID: String
    ) async {
        guard let placement = context.branchPlacement, let accountID else { return }
        do {
            try await store.recordBranch(
                accountID: StorageAccountID(accountID.rawValue),
                conversationID: context.conversationID,
                messageID: userMessageID,
                parentMessageID: placement.parentMessageID
            )
        } catch {
            guard self.accountID == accountID else { return }
            // The turn itself succeeded; only its place in the tree did not get
            // written. Say so rather than failing the message: the answer is
            // real and the reader can see it, but the pager will not show this
            // revision until the write succeeds.
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    private func visibleMessages(for conversationID: String) -> [NativeChatMessage] {
        var result = branchTreesByConversation[conversationID]?.timeline
            ?? messagesByConversation[conversationID]
            ?? []
        if let hidden = branchEditCutoffs[conversationID], !hidden.isEmpty {
            result.removeAll { hidden.contains($0.id) }
        }
        // Deduplication reads the *whole* persisted transcript, not the
        // projected slice: a transient whose server row landed on a branch this
        // timeline is not showing has still landed, and appending it here would
        // print the reader's question twice the moment they stepped away.
        let persisted = messagesByConversation[conversationID] ?? []
        let persistedIDs = Set(persisted.map(\.id))
        let persistedClientIDs = Set(persisted.compactMap(\.clientID))
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

private struct MessageAttachmentWire: Decodable {
    let id: String
    let messageId: String?
    let kind: String
    let fileName: String
    let mimeType: String
    let size: Int?
    let width: Int?
    let height: Int?
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
    /// The persisted prompt-cache split, once `Message` gained columns for it.
    ///
    /// Optional for three separate real reasons, all of which mean UNKNOWN and
    /// none of which mean zero: the message predates the columns, the provider
    /// reported no cache buckets, or it is a user turn. Decoding these as 0
    /// would make every historical turn claim a total cache miss.
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let promptTokens: Int?
    let completionTokens: Int?
    let feedback: String?
    let createdAt: String
}

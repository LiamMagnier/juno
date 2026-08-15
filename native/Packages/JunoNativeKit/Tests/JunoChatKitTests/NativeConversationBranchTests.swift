import Foundation
import JunoStorage
import JunoSync
import XCTest

@testable import JunoChatKit

/// Conversation trees: that a fork keeps the path it forked from, that the
/// active timeline is reconstructed by walking rather than by remembering, and
/// that a transcript with no recorded topology still reads exactly as it did
/// before trees existed.
final class NativeConversationBranchTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let conversationID = "conversation-a"
    private let origin = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Projection

    /// The graceful-degradation case, and by far the most common one: every
    /// conversation the server sends has no branch edges, because the backend
    /// keeps message *versions* and has no parent link to send.
    func testConversationWithNoLinksProjectsAsAPlainTranscript() {
        let messages = [
            message(id: "m3", role: .assistant, offset: 3),
            message(id: "m1", role: .user, offset: 1),
            message(id: "m2", role: .assistant, offset: 2),
        ]

        let tree = NativeConversationTreeProjection.project(messages: messages, links: [])

        XCTAssertFalse(tree.isBranched)
        XCTAssertEqual(tree.timeline.map(\.id), ["m1", "m2", "m3"])
        XCTAssertTrue(tree.positions.isEmpty)
    }

    func testActiveTimelineIsReconstructedByWalkingTheTree() {
        let messages = [
            message(id: "q1", role: .user, offset: 1),
            message(id: "a1", role: .assistant, offset: 2),
            message(id: "q1b", role: .user, offset: 3),
            message(id: "a1b", role: .assistant, offset: 4),
        ]
        let links = [
            link("q1", parent: nil, index: 0, active: false),
            link("a1", parent: "q1", index: 0, active: true),
            link("q1b", parent: nil, index: 1, active: true),
            link("a1b", parent: "q1b", index: 0, active: true),
        ]

        let tree = NativeConversationTreeProjection.project(messages: messages, links: links)

        XCTAssertTrue(tree.isBranched)
        XCTAssertEqual(tree.timeline.map(\.id), ["q1b", "a1b"])
        // The other branch is not gone — it is simply not the one being walked.
        XCTAssertEqual(tree.positions["q1"]?.index, 0)
        XCTAssertEqual(tree.positions["q1b"]?.index, 1)
        XCTAssertEqual(tree.positions["q1b"]?.siblingsCount, 2)
        XCTAssertEqual(tree.positions["q1b"]?.siblingMessageIDs, ["q1", "q1b"])
        XCTAssertFalse(tree.positions["a1b"]?.hasAlternatives ?? true)
    }

    /// A tree with no active flag anywhere still has to render something, and
    /// the first sibling is the only choice that is stable across reloads.
    func testWalkFallsBackToTheFirstSiblingWhenNoneIsMarkedActive() {
        let messages = [
            message(id: "q1", role: .user, offset: 1),
            message(id: "q2", role: .user, offset: 2),
        ]
        let links = [
            link("q1", parent: nil, index: 0, active: false),
            link("q2", parent: nil, index: 1, active: false),
        ]

        let tree = NativeConversationTreeProjection.project(messages: messages, links: links)

        XCTAssertEqual(tree.timeline.map(\.id), ["q1"])
    }

    /// A corrupt or hand-edited database must not be able to hang the transcript.
    func testCyclicLinksTerminateTheWalkInsteadOfLoopingForever() {
        let messages = [
            message(id: "a", role: .user, offset: 1),
            message(id: "b", role: .assistant, offset: 2),
        ]
        let links = [
            link("a", parent: "b", index: 0, active: true),
            link("b", parent: "a", index: 0, active: true),
        ]

        let tree = NativeConversationTreeProjection.project(messages: messages, links: links)

        XCTAssertTrue(tree.timeline.count <= messages.count)
        XCTAssertEqual(Set(tree.timeline.map(\.id)).count, tree.timeline.count)
    }

    /// An edge whose message was deleted must not become a hole that stops the
    /// walk: the rest of the conversation is still the reader's.
    func testLinksPointingAtMissingMessagesAreIgnored() {
        let messages = [message(id: "q1", role: .user, offset: 1)]
        let links = [link("vanished", parent: nil, index: 0, active: true)]

        let tree = NativeConversationTreeProjection.project(messages: messages, links: links)

        XCTAssertFalse(tree.isBranched)
        XCTAssertEqual(tree.timeline.map(\.id), ["q1"])
    }

    // MARK: - Reconciliation

    func testUnbranchedConversationsNeverGrowASpine() {
        let messages = [message(id: "m1", role: .user, offset: 1)]

        let created = NativeConversationTreeProjection.reconciliationLinks(
            conversationID: conversationID,
            messages: messages,
            links: [],
            now: origin
        )

        XCTAssertTrue(created.isEmpty)
    }

    func testNewMessagesAreAttachedToTheTipOfTheActivePath() {
        let messages = [
            message(id: "q1", role: .user, offset: 1),
            message(id: "a1", role: .assistant, offset: 2),
            message(id: "q1b", role: .user, offset: 3),
            message(id: "a1b", role: .assistant, offset: 4),
            message(id: "q2", role: .user, offset: 5),
            message(id: "a2", role: .assistant, offset: 6),
        ]
        let links = [
            link("q1", parent: nil, index: 0, active: false),
            link("a1", parent: "q1", index: 0, active: true),
            link("q1b", parent: nil, index: 1, active: true),
            link("a1b", parent: "q1b", index: 0, active: true),
        ]

        let created = NativeConversationTreeProjection.reconciliationLinks(
            conversationID: conversationID,
            messages: messages,
            links: links,
            now: origin
        )

        XCTAssertEqual(created.map(\.messageID), ["q2", "a2"])
        XCTAssertEqual(created.first { $0.messageID == "q2" }?.parentMessageID, "a1b")
        XCTAssertEqual(created.first { $0.messageID == "a2" }?.parentMessageID, "q2")

        let reconciled = NativeConversationTreeProjection.project(
            messages: messages,
            links: links + created
        )
        XCTAssertEqual(reconciled.timeline.map(\.id), ["q1b", "a1b", "q2", "a2"])
    }

    /// An unplaced message that predates the tree belongs to a branch nobody
    /// recorded. Splicing it into the current path would put one branch's words
    /// under another branch's question, so the walk waits for reconciliation.
    func testUnplacedMessagesOlderThanTheTreeAreNotSplicedIntoTheActivePath() {
        let messages = [
            message(id: "stranger", role: .assistant, offset: 1),
            message(id: "q1", role: .user, offset: 2),
            message(id: "a1", role: .assistant, offset: 3),
            message(id: "later", role: .assistant, offset: 4),
        ]
        let links = [
            link("q1", parent: nil, index: 0, active: true),
            link("a1", parent: "q1", index: 0, active: true),
        ]

        let tree = NativeConversationTreeProjection.project(messages: messages, links: links)

        XCTAssertEqual(tree.timeline.map(\.id), ["q1", "a1", "later"])
    }

    func testSpineDescribesTheTranscriptExactlyAsItAlreadyReads() {
        let messages = [
            message(id: "m1", role: .user, offset: 1),
            message(id: "m2", role: .assistant, offset: 2),
            message(id: "m3", role: .user, offset: 3),
        ]

        let spine = NativeConversationTreeProjection.spineLinks(
            conversationID: conversationID,
            messages: messages,
            now: origin
        )

        XCTAssertEqual(spine.map(\.messageID), ["m1", "m2", "m3"])
        XCTAssertNil(spine[0].parentMessageID)
        XCTAssertEqual(spine[1].parentMessageID, "m1")
        XCTAssertEqual(spine[2].parentMessageID, "m2")
        XCTAssertTrue(spine.allSatisfy(\.isActiveBranch))

        let tree = NativeConversationTreeProjection.project(messages: messages, links: spine)
        XCTAssertEqual(tree.timeline.map(\.id), messages.map(\.id))
        XCTAssertTrue(tree.positions.values.allSatisfy { !$0.hasAlternatives })
    }

    func testActiveSuffixCoversTheEditedMessageAndEverythingAfterIt() {
        let timeline = [
            message(id: "m1", role: .user, offset: 1),
            message(id: "m2", role: .assistant, offset: 2),
            message(id: "m3", role: .user, offset: 3),
        ]

        XCTAssertEqual(
            NativeConversationTreeProjection.activeSuffix(from: "m2", timeline: timeline),
            ["m2", "m3"]
        )
        XCTAssertTrue(
            NativeConversationTreeProjection
                .activeSuffix(from: "absent", timeline: timeline)
                .isEmpty
        )
    }

    // MARK: - Store integration

    func testForkKeepsBothBranchesAndTheirParentChildLinks() async throws {
        let repository = InMemoryTransactionalStore()
        let store = NativeConversationStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )
        try await seed(repository, messageIDs: ["q1", "a1"])

        let loaded = try await store.load(accountID: accountA)
        let spine = try await store.prepareBranchPoint(
            accountID: accountA,
            conversationID: conversationID,
            messages: loaded.messagesByConversation[conversationID] ?? []
        )
        XCTAssertEqual(spine.map(\.messageID), ["q1", "a1"])

        // The fork: a revision of "q1" is its SIBLING, so it hangs under q1's
        // parent (nil — q1 opens the conversation), not under q1 itself.
        try await appendMessage(repository, id: "q1b", role: "USER", offset: 3)
        try await store.recordBranch(
            accountID: accountA,
            conversationID: conversationID,
            messageID: "q1b",
            parentMessageID: nil
        )
        try await appendMessage(repository, id: "a1b", role: "ASSISTANT", offset: 4)

        let forked = try await store.load(accountID: accountA)
        let links = forked.branchLinksByConversation[conversationID] ?? []

        // Nothing was overwritten: the original question, its answer, and the
        // revision all still have rows and all still have their parents.
        XCTAssertEqual(
            Set(links.map(\.messageID)),
            ["q1", "a1", "q1b", "a1b"]
        )
        XCTAssertEqual(links.first { $0.messageID == "a1" }?.parentMessageID, "q1")
        XCTAssertNil(links.first { $0.messageID == "q1b" }?.parentMessageID)
        XCTAssertEqual(links.first { $0.messageID == "q1b" }?.branchIndex, 1)
        // Reconciliation attached the new answer to the branch that is active.
        XCTAssertEqual(links.first { $0.messageID == "a1b" }?.parentMessageID, "q1b")

        let tree = NativeConversationTreeProjection.project(
            messages: forked.messagesByConversation[conversationID] ?? [],
            links: links
        )
        XCTAssertEqual(tree.timeline.map(\.id), ["q1b", "a1b"])
        XCTAssertEqual(tree.positions["q1b"]?.siblingsCount, 2)
    }

    func testSwitchingBackRestoresTheOriginalPathWithoutLosingTheNewOne() async throws {
        let repository = InMemoryTransactionalStore()
        let store = NativeConversationStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )
        try await seed(repository, messageIDs: ["q1", "a1"])
        let loaded = try await store.load(accountID: accountA)
        _ = try await store.prepareBranchPoint(
            accountID: accountA,
            conversationID: conversationID,
            messages: loaded.messagesByConversation[conversationID] ?? []
        )
        try await appendMessage(repository, id: "q1b", role: "USER", offset: 3)
        try await store.recordBranch(
            accountID: accountA,
            conversationID: conversationID,
            messageID: "q1b",
            parentMessageID: nil
        )
        try await appendMessage(repository, id: "a1b", role: "ASSISTANT", offset: 4)
        _ = try await store.load(accountID: accountA)

        let switched = try await store.activateBranch(accountID: accountA, messageID: "q1")
        XCTAssertTrue(switched)

        let reloaded = try await store.load(accountID: accountA)
        let tree = NativeConversationTreeProjection.project(
            messages: reloaded.messagesByConversation[conversationID] ?? [],
            links: reloaded.branchLinksByConversation[conversationID] ?? []
        )
        XCTAssertEqual(tree.timeline.map(\.id), ["q1", "a1"])
        // Every message of both branches is still stored — switching hides, it
        // never deletes.
        XCTAssertEqual(
            Set((reloaded.messagesByConversation[conversationID] ?? []).map(\.id)),
            ["q1", "a1", "q1b", "a1b"]
        )
    }

    func testLoadingAnUnbranchedAccountWritesNoTopology() async throws {
        let repository = InMemoryTransactionalStore()
        let store = NativeConversationStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )
        try await seed(repository, messageIDs: ["q1", "a1"])

        let snapshot = try await store.load(accountID: accountA)

        XCTAssertTrue(snapshot.branchLinksByConversation.isEmpty)
        let stored = try await repository.messageBranchLinks(for: accountA)
        XCTAssertTrue(stored.isEmpty)
    }

    func testDeletingAConversationRemovesItsEdges() async throws {
        let repository = InMemoryTransactionalStore()
        let store = NativeConversationStore(
            repository: repository,
            outbox: InMemoryMutationOutbox()
        )
        try await seed(repository, messageIDs: ["q1", "a1"])
        let loaded = try await store.load(accountID: accountA)
        _ = try await store.prepareBranchPoint(
            accountID: accountA,
            conversationID: conversationID,
            messages: loaded.messagesByConversation[conversationID] ?? []
        )

        try await store.removeBranchLinks(
            accountID: accountA,
            conversationID: conversationID
        )

        let stored = try await repository.messageBranchLinks(for: accountA)
        XCTAssertTrue(stored.isEmpty)
    }

    // MARK: - Navigator arithmetic

    func testPagerStopsAtBothEndsRatherThanWrapping() {
        let position = NativeMessageBranchPosition(
            index: 0,
            siblingMessageIDs: ["a", "b", "c"]
        )

        XCTAssertNil(position.siblingID(steppedBy: -1))
        XCTAssertEqual(position.siblingID(steppedBy: 1), "b")
        XCTAssertEqual(
            NativeMessageBranchPosition(index: 2, siblingMessageIDs: ["a", "b", "c"])
                .siblingID(steppedBy: 1),
            nil
        )
        XCTAssertFalse(
            NativeMessageBranchPosition(index: 0, siblingMessageIDs: ["only"])
                .hasAlternatives
        )
    }

    // MARK: - Helpers

    private func message(
        id: String,
        role: NativeChatRole,
        offset: TimeInterval
    ) -> NativeChatMessage {
        NativeChatMessage(
            id: id,
            conversationID: conversationID,
            clientID: nil,
            role: role,
            content: id,
            reasoning: nil,
            model: nil,
            createdAt: origin.addingTimeInterval(offset),
            revision: 1
        )
    }

    private func link(
        _ messageID: String,
        parent: String?,
        index: Int,
        active: Bool
    ) -> MessageBranchLink {
        MessageBranchLink(
            conversationID: conversationID,
            messageID: messageID,
            parentMessageID: parent,
            branchIndex: index,
            isActiveBranch: active,
            createdAt: origin
        )
    }

    private func seed(
        _ repository: InMemoryTransactionalStore,
        messageIDs: [String]
    ) async throws {
        let conversation = """
        {"id":"\(conversationID)","title":"Branching","model":"openai:gpt-5",\
        "kind":"chat","pinned":false,"archivedAt":null,\
        "createdAt":"2026-07-21T12:00:00.000Z","updatedAt":"2026-07-21T12:01:00.000Z",\
        "lastMessageAt":"2026-07-21T12:02:00.000Z"}
        """
        _ = try await repository.apply(
            StorageTransaction(
                accountID: accountA,
                operations: [
                    .upsert(
                        StoredRecord(
                            accountID: accountA,
                            key: RecordKey(namespace: "conversation", id: conversationID),
                            revision: 1,
                            updatedAt: origin,
                            payload: Data(conversation.utf8)
                        )
                    )
                ]
            )
        )
        for (index, messageID) in messageIDs.enumerated() {
            try await appendMessage(
                repository,
                id: messageID,
                role: index.isMultiple(of: 2) ? "USER" : "ASSISTANT",
                offset: TimeInterval(index + 1)
            )
        }
    }

    private func appendMessage(
        _ repository: InMemoryTransactionalStore,
        id: String,
        role: String,
        offset: TimeInterval
    ) async throws {
        // Built per call rather than shared: `ISO8601DateFormatter` is not
        // Sendable, and a static one would be a data race dressed up as a
        // convenience. Fractional seconds match what the server sends, so these
        // fixtures are parsed by exactly the path real rows are parsed by.
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let createdAt = formatter.string(from: origin.addingTimeInterval(offset))
        let payload = """
        {"id":"\(id)","conversationId":"\(conversationID)","clientId":null,\
        "role":"\(role)","content":"\(id)","reasoning":null,"model":null,\
        "createdAt":"\(createdAt)"}
        """
        _ = try await repository.apply(
            StorageTransaction(
                accountID: accountA,
                operations: [
                    .upsert(
                        StoredRecord(
                            accountID: accountA,
                            key: RecordKey(namespace: "message", id: id),
                            revision: 1,
                            updatedAt: origin.addingTimeInterval(offset),
                            payload: Data(payload.utf8)
                        )
                    )
                ]
            )
        )
    }
}

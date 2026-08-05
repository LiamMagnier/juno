import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import XCTest

@testable import JunoChatKit

/// The rules that decide what the composer and the transcript do with a very
/// long prompt.
///
/// These are the web's numbers (`src/lib/prompt-limits.ts`), and the reason they
/// are asserted rather than trusted is that all three are *invisible when
/// correct*: a bubble that collapses at the wrong threshold looks exactly like a
/// bubble, and a line counter that walks a multi-megabyte paste looks exactly
/// like a slow phone.
final class NativePromptLimitsTests: XCTestCase {
    // MARK: - Line counting

    func testLineCountIsSampledAndNeverWalksTheWholeString() {
        // Ten newlines in the first 20 characters, then a megabyte of nothing.
        let head = String(repeating: "a\n", count: 10)
        let text = head + String(repeating: "x", count: 1_000_000)

        // 10 newlines → 11 lines, and the sample stops long before the tail.
        XCTAssertEqual(NativePromptLimits.sampleLineCount(text, sampleCharacters: 100), 11)
    }

    func testLineCountStopsAtTheSampleBoundary() {
        let text = String(repeating: "\n", count: 500)
        // Only the first 10 bytes are read: 10 newlines on top of the first line.
        XCTAssertEqual(NativePromptLimits.sampleLineCount(text, sampleCharacters: 10), 11)
    }

    func testEmptyTextHasNoLines() {
        XCTAssertEqual(NativePromptLimits.sampleLineCount(""), 0)
    }

    // MARK: - Collapsing a sent message

    func testShortMessagesAreNotCollapsed() {
        XCTAssertFalse(NativePromptLimits.isLongMessage("Hello Juno"))
        XCTAssertFalse(
            NativePromptLimits.isLongMessage(String(repeating: "a", count: 700))
        )
    }

    func testLongMessagesCollapseByLength() {
        XCTAssertTrue(
            NativePromptLimits.isLongMessage(String(repeating: "a", count: 701))
        )
    }

    /// A short message can still be tall. Fifteen one-word lines is well under
    /// 700 characters and still fills a phone screen, which is exactly the case
    /// the character threshold alone would miss.
    func testLongMessagesCollapseByLineCount() {
        let tall = String(repeating: "hi\n", count: 15)
        XCTAssertLessThan(tall.count, NativePromptLimits.longMessageCharacters)
        XCTAssertTrue(NativePromptLimits.isLongMessage(tall))
    }

    // MARK: - Drafts

    func testAttachAsFileIsOfferedOnlyOnceTheDraftIsLong() {
        XCTAssertFalse(NativePromptLimits.isLongDraft("Write me a haiku"))
        XCTAssertTrue(
            NativePromptLimits.isLongDraft(String(repeating: "a", count: 1_501))
        )
    }

    /// Trailing whitespace does not make a draft long — the web trims before it
    /// measures, and a draft that offers to become a file because of a newline
    /// at the end would be nonsense.
    func testDraftLengthIgnoresSurroundingWhitespace() {
        let padded = "  " + String(repeating: "a", count: 1_400) + "\n  "
        XCTAssertFalse(NativePromptLimits.isLongDraft(padded))
    }

    func testHugeDraftsLeaveTheTextField() {
        XCTAssertFalse(
            NativePromptLimits.isHugeDraft(String(repeating: "a", count: 8_000))
        )
        XCTAssertTrue(
            NativePromptLimits.isHugeDraft(String(repeating: "a", count: 8_001))
        )
    }

    /// The two thresholds have to stay in this order: a draft that is too big to
    /// keep in the field must always already have been offered as a file.
    func testEveryHugeDraftIsAlsoALongOne() {
        let huge = String(repeating: "a", count: NativePromptLimits.composerInlineSoftCharacters + 1)
        XCTAssertTrue(NativePromptLimits.isHugeDraft(huge))
        XCTAssertTrue(NativePromptLimits.isLongDraft(huge))
    }
}

/// What the app opens on, and whether a message with no text can be sent.
///
/// Both are one-line rules in `NativeConversationModel`, and both are the kind of
/// rule that is only ever noticed when it is wrong: the phone launching into
/// last night's conversation instead of its home screen, and "Attach as file"
/// leaving a draft that Send refuses.
@MainActor
final class NativeConversationSelectionTests: XCTestCase {
    private let account = "account-a"

    /// An explicit resume policy still supports opening the most recent chat.
    func testExplicitResumePolicyOpensTheMostRecentConversation() async throws {
        let model = try await makeModel(opensMostRecent: true)
        await model.start(for: try AccountID(account))

        XCTAssertEqual(model.selectedConversationID, "conversation-a")
    }

    /// Desktop and phone pass the home policy: nothing selected means the
    /// greeting and an empty composer, which is what chat.liams.dev opens on.
    func testHomePolicyOpensOnTheHomeScreen() async throws {
        let model = try await makeModel(opensMostRecent: false)
        await model.start(for: try AccountID(account))

        XCTAssertNil(model.selectedConversationID)
    }

    /// And it stays home across the sync ticks that follow a launch, which is
    /// where the old fallback did its damage: the reader tapped New chat, a
    /// reload landed, and they were back in the conversation they had left.
    func testHomePolicyStaysHomeAcrossReloads() async throws {
        let model = try await makeModel(opensMostRecent: false)
        await model.start(for: try AccountID(account))
        await model.reload()
        await model.reload()

        XCTAssertNil(model.selectedConversationID)
    }

    // MARK: - Helpers

    private func makeModel(
        opensMostRecent: Bool
    ) async throws -> NativeConversationModel<InMemoryTransactionalStore> {
        let repository = InMemoryTransactionalStore()
        try await seedConversation(repository)
        let sender = UnreachableSender()
        let outbox = InMemoryMutationOutbox()
        let coordinator = NativeSyncCoordinator(repository: repository, sender: sender)
        return NativeConversationModel(
            repository: repository,
            outbox: outbox,
            drainer: NativeMutationDrainer(
                repository: repository, outbox: outbox, sender: sender
            ),
            syncModel: NativeSyncModel(
                coordinator: coordinator,
                monitor: NativeSyncMonitor(coordinator: coordinator, streamer: sender)
            ),
            opensMostRecentConversationOnLoad: opensMostRecent
        )
    }

    private func seedConversation(_ repository: InMemoryTransactionalStore) async throws {
        let payload = """
        {"id":"conversation-a","title":"Yesterday","model":"openai:gpt-5","kind":"chat",\
        "pinned":false,"archivedAt":null,"createdAt":"2026-07-21T12:00:00.000Z",\
        "updatedAt":"2026-07-21T12:01:00.000Z","lastMessageAt":"2026-07-21T12:02:00.000Z"}
        """
        _ = try await repository.apply(StorageTransaction(
            accountID: StorageAccountID(account),
            operations: [
                .upsert(StoredRecord(
                    accountID: StorageAccountID(account),
                    key: RecordKey(namespace: "conversation", id: "conversation-a"),
                    revision: 7,
                    updatedAt: Date(timeIntervalSince1970: 10),
                    payload: Data(payload.utf8)
                ))
            ]
        ))
    }
}

/// A transport that is never expected to be reached: these tests read the local
/// mirror only, and a request escaping to the network would make them flaky
/// rather than wrong, which is worse.
private struct UnreachableSender: NativeAuthenticatedRequestSending,
    NativeAuthenticatedByteStreaming, Sendable
{
    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws
        -> HTTPResponse
    { throw URLError(.notConnectedToInternet) }

    func stream(
        _ request: NativeBearerRequest,
        for accountID: AccountID
    ) async throws -> HTTPByteStreamResponse { throw URLError(.notConnectedToInternet) }
}

/// What the "Show more" control says it is hiding.
final class NativePromptCollapsedSummaryTests: XCTestCase {
    /// The case the web's unconditional "N lines" gets wrong: one long
    /// paragraph, no newlines, and a control that read "Show more · 1 lines".
    func testAParagraphIsMeasuredInCharacters() {
        let paragraph = String(repeating: "a", count: 1_234)
        XCTAssertEqual(
            NativePromptLimits.collapsedSummary(for: paragraph, locale: Locale(identifier: "en_US")),
            "1,234 characters"
        )
    }

    func testALineShapedPromptIsMeasuredInLines() {
        let prompt = String(repeating: "line\n", count: 21) + "line"
        XCTAssertEqual(
            NativePromptLimits.collapsedSummary(for: prompt, locale: Locale(identifier: "en_US")),
            "22 lines"
        )
    }
}

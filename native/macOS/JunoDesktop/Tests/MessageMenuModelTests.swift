import Foundation
import Testing

@testable import JunoDesktop

/// What a turn's action row and menus hold, per kind of turn (§3.2 of the
/// Phase 2 brief). Menus cannot be drawn offscreen, so their contents are
/// pinned here instead of in a snapshot.
struct MessageMenuModelTests {
    private let meta = "9.0K tokens (8.4K in · 612 out) · $0.021"

    @Test
    func theNewestReplyShowsFiveActions() {
        let model = MessageMenuModel(.init(isNewest: true, modelName: "Claude Sonnet 4.6", meta: meta))
        #expect(model.row == [.copy, .goodResponse, .badResponse, .regenerate, .more])
        #expect(model.regenerate == [.tryAgain, .switchModel, .divider, .moreConcise, .addDetails])
        #expect(model.more == [
            .readAloud,
            .branch([.intoNewChat, .forkPrivately]),
            .shareChat,
            .divider,
            .quote,
            .copyLink,
            .divider,
            .info(model: "Claude Sonnet 4.6", meta: meta),
        ])
    }

    @Test
    func anOlderReplyCannotBeRegenerated() {
        let model = MessageMenuModel(.init(isNewest: false))
        #expect(model.row == [.copy, .goodResponse, .badResponse, .more])
        #expect(model.regenerate.isEmpty)
    }

    @Test
    func nothingRegeneratesOrBranchesWhileAReplyIsBeingWritten() {
        let model = MessageMenuModel(.init(isNewest: true, isGenerating: true))
        #expect(!model.row.contains(.regenerate))
        #expect(!model.more.contains { if case .branch = $0 { true } else { false } })
    }

    @Test
    func aPrivateTurnCopiesReadsAndQuotesOnly() {
        let model = MessageMenuModel(.init(isNewest: true, isPrivate: true, isSaved: false))
        #expect(model.row == [.copy, .more])
        #expect(model.more == [.readAloud, .divider, .quote])
    }

    @Test
    func anImageOnlyReplyIsRatedAndNothingElseAtRest() {
        let model = MessageMenuModel(.init(
            hasText: false,
            isMediaOnly: true,
            isNewest: true,
            modelName: "GPT Image 2",
            meta: "140 tokens (140 in · 0 out) · $0.042"
        ))
        #expect(model.row == [.goodResponse, .badResponse, .more])
        // No words: nothing to read aloud or quote — but it can still branch,
        // share, link, and say what it cost.
        #expect(model.more == [
            .branch([.intoNewChat, .forkPrivately]),
            .shareChat,
            .divider,
            .copyLink,
            .divider,
            .info(model: "GPT Image 2", meta: "140 tokens (140 in · 0 out) · $0.042"),
        ])
    }

    @Test
    func anUnsavedTurnHasNothingToShareBranchOrLinkTo() {
        let model = MessageMenuModel(.init(isNewest: true, isSaved: false))
        #expect(model.more == [.readAloud, .branch([.forkPrivately]), .divider, .quote])
    }

    @Test
    func readingAloudBecomesStopReading() {
        let model = MessageMenuModel(.init(isSpeaking: true))
        #expect(model.more.first == .stopReading)
    }

    @Test
    func theReceiptAloneStillOpensMore() {
        let model = MessageMenuModel(.init(
            hasText: false,
            isPrivate: true,
            isSaved: false,
            canReadAloud: false,
            canQuote: false,
            modelName: "Claude Sonnet 4.6"
        ))
        #expect(model.row == [.more])
        #expect(model.more == [.info(model: "Claude Sonnet 4.6", meta: nil)])
    }

    @Test
    func quotingSeedsEveryLineAndLeavesRoomToReply() {
        #expect(ChatComposerRequest.quoted("  One\nTwo\n\n") == "> One\n> Two\n\n")
    }

    @Test
    func switchModelListsChatModelsByProvider() {
        let groups = DesktopRegenerateModel.grouped([
            DesktopRegenerateModel(id: "a:1", name: "A1", provider: "a", providerLabel: "Alpha"),
            DesktopRegenerateModel(id: "b:1", name: "B1", provider: "b", providerLabel: "Beta"),
            DesktopRegenerateModel(id: "a:2", name: "A2", provider: "a", providerLabel: "Alpha"),
        ])
        #expect(groups.map(\.providerLabel) == ["Alpha", "Beta"])
        #expect(groups.first?.models.map(\.id) == ["a:1", "a:2"])
    }
}

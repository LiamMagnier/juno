import Foundation
import JunoAuth
import JunoChatKit
import Testing
@testable import JunoDesktop

/// The Chat shell's pure rules (Phase 1b of the Liquid Glass redesign): what
/// the column draws, what the footer's plan word says, and which offline
/// state the chat column reports.
///
/// Each is a rule a screenshot would pass while being wrong — a Code session
/// in Chat's Recent, "Pro" printed for an account at its limit, a network
/// outage offered a Retry that cannot help — so each is asserted here.
struct DesktopChatShellTests {
    // MARK: - The column's data

    /// Errata 6: Code's conversations stay in the store — `sendMessage`
    /// refuses a conversation the store has never heard of — so the Chat
    /// column is what filters them out, and archived chats with them.
    @Test
    func theColumnDrawsChatsOnlyNewestFirst() {
        let conversations = [
            conversation("old", minutesAgo: 30),
            conversation("code", kind: "code", minutesAgo: 1),
            conversation("archived", minutesAgo: 2, archived: true),
            conversation("new", minutesAgo: 5),
        ]
        let chats = DesktopChatSidebarContent.chats(from: conversations)
        #expect(chats.map(\.id) == ["new", "old"])
    }

    /// Pinned chats leave Recent; Needs you takes a row from both, because a
    /// row can be in only one place and that is the one with a person waiting.
    @Test
    func pinnedAndRecentSplitTheChatsAndNeedsYouWins() {
        let chats = [
            conversation("a", minutesAgo: 1, pinned: true),
            conversation("b", minutesAgo: 2),
            conversation("c", minutesAgo: 3, pinned: true),
            conversation("d", minutesAgo: 4),
        ]
        #expect(DesktopChatSidebarContent.pinned(from: chats).map(\.id) == ["a", "c"])
        #expect(DesktopChatSidebarContent.recent(from: chats).map(\.id) == ["b", "d"])

        let waiting: Set = ["a", "b"]
        #expect(DesktopChatSidebarContent.pinned(from: chats, excluding: waiting).map(\.id) == ["c"])
        #expect(DesktopChatSidebarContent.recent(from: chats, excluding: waiting).map(\.id) == ["d"])
    }

    /// A project's chats stay in Recent as well as under the project: a
    /// project is a workspace, not a filing.
    @Test
    func projectChatsAreListedUnderTheProjectAndInRecent() {
        let chats = [
            conversation("in", minutesAgo: 1, projectID: "p1"),
            conversation("out", minutesAgo: 2),
        ]
        #expect(DesktopChatSidebarContent.chats(inProject: "p1", from: chats).map(\.id) == ["in"])
        #expect(DesktopChatSidebarContent.recent(from: chats).map(\.id) == ["in", "out"])
    }

    @Test
    func onlyStarredProjectsArePinned() {
        let projects = [project("p1", starred: true), project("p2", starred: false)]
        #expect(DesktopChatSidebarContent.pinnedProjects(from: projects).map(\.id) == ["p1"])
    }

    @Test
    func recentPagesInForties() {
        #expect(DesktopChatSidebarContent.recentPage == 40)
        #expect(DesktopChatSidebarContent.projectPreview == 3)
    }

    /// Rename… on a chat past the loaded page of Recent pages far enough to
    /// draw its row — the rename field lives there — in whole pages, and never
    /// takes rows away that are already drawn.
    @Test
    func revealingARenamedChatPagesRecentFarEnoughToDrawIt() {
        #expect(DesktopChatSidebarContent.recentLimit(revealing: 12, current: 40) == 40)
        #expect(DesktopChatSidebarContent.recentLimit(revealing: 40, current: 40) == 80)
        #expect(DesktopChatSidebarContent.recentLimit(revealing: 95, current: 40) == 120)
        #expect(DesktopChatSidebarContent.recentLimit(revealing: 3, current: 120) == 120)
    }

    /// A chat in a pinned project is drawn twice; the scroll target is the
    /// chat's own row, so its identity must not collide with the chat's id.
    @Test
    func aChatsOwnRowHasANamespacedScrollIdentity() {
        #expect(DesktopChatSidebarContent.scrollID(for: "c1") == "conversation-row:c1")
        #expect(DesktopChatSidebarContent.scrollID(for: "c1") != "c1")
    }

    // MARK: - The footer's plan word

    /// Below 80% the footer names the plan and says nothing about usage.
    @Test
    func thePlanWordIsThePlanBelowEightyPercent() {
        let word = DesktopFooterPlanWord(
            planName: "Pro", weeklyFraction: 0.62, isUnlimited: false, isBrowseOnly: false
        )
        #expect(word == DesktopFooterPlanWord(text: "Pro", tone: .quiet))
    }

    @Test
    func thePlanWordWarnsFromEightyPercent() {
        #expect(
            DesktopFooterPlanWord(
                planName: "Pro", weeklyFraction: 0.8, isUnlimited: false, isBrowseOnly: false
            ) == DesktopFooterPlanWord(text: "20% left", tone: .warning)
        )
        #expect(
            DesktopFooterPlanWord(
                planName: "Pro", weeklyFraction: 0.994, isUnlimited: false, isBrowseOnly: false
            ) == DesktopFooterPlanWord(text: "1% left", tone: .warning)
        )
    }

    @Test
    func thePlanWordSaysLimitReachedAtOneHundred() {
        #expect(
            DesktopFooterPlanWord(
                planName: "Pro", weeklyFraction: 1.3, isUnlimited: false, isBrowseOnly: false
            ) == DesktopFooterPlanWord(text: "Limit reached", tone: .destructive)
        )
    }

    /// A plan that cannot run out is never told it is running out, whatever
    /// fraction the route reports for it.
    @Test
    func anUnlimitedOrBrowseOnlyPlanIsJustItsName() {
        #expect(
            DesktopFooterPlanWord(
                planName: "Owner", weeklyFraction: 1, isUnlimited: true, isBrowseOnly: false
            ) == DesktopFooterPlanWord(text: "Owner", tone: .quiet)
        )
        #expect(
            DesktopFooterPlanWord(
                planName: "Free", weeklyFraction: 1, isUnlimited: false, isBrowseOnly: true
            ) == DesktopFooterPlanWord(text: "Free", tone: .quiet)
        )
    }

    @Test
    func aNonFiniteFractionReadsAsNothingUsed() {
        #expect(DesktopFooterPlanWord.percentUsed(fraction: .nan) == 0)
        #expect(DesktopFooterPlanWord.percentUsed(fraction: -1) == 0)
        #expect(DesktopFooterPlanWord.percentUsed(fraction: 2) == 100)
    }

    // MARK: - Offline

    /// Errata 7: an unconfirmed session and a sync outage are different
    /// states. Only the first has a Retry that can do anything, and it wins
    /// when both are true.
    @Test
    func anUnconfirmedSessionIsNotTheSameAsOffline() {
        #expect(
            DesktopOfflineState.resolve(connectivity: .confirmed, syncPhase: .offline) == .offline
        )
        #expect(
            DesktopOfflineState.resolve(
                connectivity: .unreachable("timed out"),
                syncPhase: .offline
            ) == .unreachable(cause: "timed out")
        )
        #expect(DesktopOfflineState.resolve(connectivity: .confirmed, syncPhase: .live) == nil)
        // A sync the server refused is not an outage: the footer's warning
        // mark reports it, and the column says nothing about connectivity.
        #expect(DesktopOfflineState.resolve(connectivity: .confirmed, syncPhase: .failed) == nil)
        #expect(DesktopOfflineState.resolve(connectivity: .confirmed, syncPhase: nil) == nil)
    }

    // MARK: - Share

    /// A row's Share… selects its chat and shares it in one gesture. The
    /// window closes the Share popover when the selection moves — but not when
    /// it moves *to* the chat being shared, or the close could land on the
    /// popover just opened for it and leave the link copied in silence.
    @Test
    func selectingTheSharedChatKeepsItsPopoverOpen() {
        #expect(!DesktopShareState.selectionClosesPopover(sharing: "a", selected: "a"))
        #expect(DesktopShareState.selectionClosesPopover(sharing: "a", selected: "b"))
        #expect(DesktopShareState.selectionClosesPopover(sharing: "a", selected: nil))
        #expect(DesktopShareState.selectionClosesPopover(sharing: nil, selected: "b"))
    }

    // MARK: - Fixtures

    private func conversation(
        _ id: String,
        kind: String = "chat",
        minutesAgo: Double,
        pinned: Bool = false,
        archived: Bool = false,
        projectID: String? = nil
    ) -> NativeConversation {
        let date = Date(timeIntervalSince1970: 1_800_000_000).addingTimeInterval(-minutesAgo * 60)
        return NativeConversation(
            id: id,
            title: id,
            model: "juno:auto",
            kind: kind,
            pinned: pinned,
            archivedAt: archived ? date : nil,
            createdAt: date,
            updatedAt: date,
            lastMessageAt: date,
            revision: 1,
            projectId: projectID
        )
    }

    private func project(_ id: String, starred: Bool) -> NativeProject {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        return NativeProject(
            id: id,
            name: id,
            instructions: "",
            starred: starred,
            createdAt: date,
            updatedAt: date,
            revision: 1
        )
    }
}

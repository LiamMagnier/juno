import Foundation
import JunoDesignSystem
import Testing
@testable import JunoDesktop

/// The empty chat's rules (Phase 1c of the Liquid Glass redesign, §4) and the
/// in-shell states' (§5.8).
///
/// Each is something a screenshot passes while being wrong: a greeting that
/// addresses the reader by their surname, a size that does not follow the
/// column, a chip that sends instead of seeding, a meter that dances in a quiet
/// room.
@MainActor
struct DesktopEmptyChatTests {
    // MARK: - The greeting

    /// The first word of the name, as the web's `user.name?.trim().split(/\s+/)[0]`
    /// — whatever whitespace separates the words — and nothing at all for an
    /// account with no name, which reads "How can I help?".
    @Test
    func theGreetingAddressesTheFirstName() {
        #expect(ChatGreeting.firstName(from: "Liam Magnier") == "Liam")
        #expect(ChatGreeting.firstName(from: "  Liam\tMagnier ") == "Liam")
        #expect(ChatGreeting.firstName(from: "Cher") == "Cher")
        #expect(ChatGreeting.firstName(from: "   ") == nil)
        #expect(ChatGreeting.firstName(from: "") == nil)
        #expect(ChatGreeting.firstName(from: nil) == nil)
    }

    /// The web's `clamp(2rem, .3333rem + 4.1667cqi, 3rem)`, against the chat
    /// column's width: 32 at 640 and below, 48 at 1024 and above, linear
    /// between (§4.2).
    @Test
    func theGreetingIsFluidFrom32To48AcrossTheColumn() {
        #expect(ChatGreeting.size(forColumnWidth: 400) == 32)
        #expect(ChatGreeting.size(forColumnWidth: 640) == 32)
        #expect(abs(ChatGreeting.size(forColumnWidth: 832) - 40) < 0.1)
        #expect(abs(ChatGreeting.size(forColumnWidth: 1024) - 48) < 0.01)
        #expect(ChatGreeting.size(forColumnWidth: 1600) == 48)
    }

    // MARK: - Starter chips

    /// The four chips, in the web's order, with the web's seeds verbatim: each
    /// an opening that ends in a space where the reader's subject begins.
    @Test
    func theStarterChipsSeedTheWebsOpenings() {
        #expect(ChatStarterChip.all.map(\.label) == ["Research", "Write", "Code", "Plan"])
        #expect(ChatStarterChip.all.map(\.seed) == [
            "Research and cite sources on ",
            "Help me write ",
            "Write code that ",
            "Plan the steps to ",
        ])
        #expect(ChatStarterChip.all.allSatisfy { $0.seed.hasSuffix(" ") })
        #expect(ChatStarterChip.all.map(\.icon) == [.research, .pencil, .code, .task])
    }

    /// A chip seeds the composer through the same request channel as ⌘U and
    /// a drop, as its own kind — so the composer replaces the draft and places
    /// the caret, and nothing about it can reach the send path.
    @Test
    func aChipIsASeedRequestNotASend() {
        let request = ChatComposerRequest(kind: .seed("Help me write "))
        #expect(request.kind == .seed("Help me write "))
        #expect(request.kind != .chooseFiles)
        #expect(ChatComposerRequest(kind: .seed("x")).id != request.id)
    }

    // MARK: - The handoff

    /// The handoff's beats are the web's: the bubble waits 60ms, the chips
    /// deal in 120ms after the greeting and 30ms apart, and a turn rises the
    /// ladder's own 6pt.
    @Test
    func theHandoffKeepsTheWebsBeats() {
        #expect(DesktopChoreography.firstTurnBeat == 0.06)
        #expect(DesktopChoreography.chipsBeat == 0.12)
        #expect(DesktopChoreography.chipStagger == 0.03)
        #expect(DesktopChoreography.riseDistance == JunoMotion.riseDistance)
        #expect(DesktopChoreography.greetingExitScale == 0.985)
    }

    // MARK: - The level meter

    /// Five bars on staggered gains, 6 to 18pt tall; still below the noise
    /// floor, so a quiet room does not look like speech.
    @Test
    func theMeterIsStillInAQuietRoomAndPeaksInTheMiddle() {
        #expect(ComposerLevelMeter.gains.count == 5)
        for gain in ComposerLevelMeter.gains {
            #expect(ComposerLevelMeter.height(level: 0.01, gain: gain) == ComposerLevelMeter.minimumHeight)
        }
        #expect(ComposerLevelMeter.height(level: 1, gain: 1) == ComposerLevelMeter.maximumHeight)
        #expect(ComposerLevelMeter.height(level: 3, gain: 1) == ComposerLevelMeter.maximumHeight)
        let loud = ComposerLevelMeter.gains.map { ComposerLevelMeter.height(level: 0.8, gain: $0) }
        #expect(loud[2] > loud[1] && loud[1] > loud[0])
        #expect(loud[0] == loud[4] && loud[1] == loud[3])
    }
}

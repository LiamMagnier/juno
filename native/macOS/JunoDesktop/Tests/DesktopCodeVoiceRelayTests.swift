import Foundation
import JunoCodeUI
import JunoVoiceKit
import Testing
@testable import JunoDesktop

/// The Code call's arrangement (owner, 2026-10-10: auto-send each sentence):
/// every finished sentence the reader says becomes the thread's next turn,
/// once, and when the run finishes its reply is handed back to be spoken.
struct DesktopCodeVoiceRelayTests {
    private typealias Line = JunoRealtimeVoiceController.TranscriptLine

    @Test
    func eachFinishedSentenceGoesToTheThreadOnce() {
        var relay = DesktopCodeVoiceRelay()
        let first = Line(role: .user, text: "Add a test for the totals", final: true)
        let partial = Line(role: .user, text: "and then run", final: false)
        let reply = Line(role: .assistant, text: "On it.", final: true)
        #expect(relay.requests(in: [first, partial, reply]) == ["Add a test for the totals"])
        // The same transcript again (it is re-read on every change): nothing new.
        #expect(relay.requests(in: [first, partial, reply]).isEmpty)
        // The partial line finishes: it goes now, by itself.
        let finished = Line(id: partial.id, role: .user, text: "and then run the suite", final: true)
        #expect(relay.requests(in: [first, finished, reply]) == ["and then run the suite"])
    }

    @Test
    func emptyLinesAndTheReadBackPromptAreNeverSent() {
        var relay = DesktopCodeVoiceRelay()
        let lines = [
            Line(role: .user, text: "   ", final: true),
            Line(role: .user, text: DesktopCodeVoiceRelay.readBackPrompt, final: true),
            Line(role: .user, text: " Ship it ", final: true),
        ]
        #expect(relay.requests(in: lines) == ["Ship it"])
    }

    @Test
    func aReplyIsSpokenOnceWhenTheRunStops() {
        var relay = DesktopCodeVoiceRelay()
        #expect(relay.reply(wasRunning: false, isRunning: true, latest: "Working") == nil, "only on a stop")
        #expect(relay.reply(wasRunning: true, isRunning: true, latest: "Working") == nil)
        #expect(relay.reply(wasRunning: true, isRunning: false, latest: "  Tests pass. ") == "Tests pass.")
        #expect(relay.reply(wasRunning: true, isRunning: false, latest: "Tests pass.") == nil, "never the same reply twice")
        #expect(relay.reply(wasRunning: true, isRunning: false, latest: "") == nil)
        #expect(relay.reply(wasRunning: true, isRunning: false, latest: nil) == nil)
        #expect(relay.reply(wasRunning: true, isRunning: false, latest: "Pushed the branch.") == "Pushed the branch.")
    }

    @Test
    func theReadBackIsBoundedToWhatTheSocketTakes() {
        let long = String(repeating: "a", count: JunoVoiceHistoryEntry.maximumContextCharacters * 2)
        let context = DesktopCodeVoiceRelay.readBackContext(long)
        #expect(context.count == JunoVoiceHistoryEntry.maximumContextCharacters)
        #expect(context.hasPrefix("Alevr Code's reply"))
    }

    @Test
    func theBriefingSaysWhereTheCallSends() {
        let history = DesktopCodeVoiceBriefing.history(
            place: "storefront",
            turns: [(.user, "Fix the cart"), (.assistant, "Fixed.")]
        )
        #expect(history.first?.text.contains("working in storefront") == true)
        #expect(history.first?.text.contains("sent to Alevr Code as their next instruction") == true)
        #expect(history.count == 3)
    }
}

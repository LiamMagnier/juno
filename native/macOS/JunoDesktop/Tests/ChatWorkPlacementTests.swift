import Foundation
import JunoCore
import Testing

@testable import JunoDesktop

/// Where a task sits in its chat, and the words the card says (Phase 5 A4, A5).
struct ChatWorkPlacementTests {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    private func turn(_ id: String, user: Bool, at offset: TimeInterval) -> ChatWorkPlacement.Turn {
        ChatWorkPlacement.Turn(id: id, isUser: user, createdAt: t0.addingTimeInterval(offset))
    }

    /// After the reply that follows the last question asked at or before the
    /// task was composed — the web's `MessageList` rule.
    @Test
    func aTaskFollowsTheReplyToItsTurn() {
        let turns = [
            turn("q1", user: true, at: 0), turn("a1", user: false, at: 5),
            turn("q2", user: true, at: 100), turn("a2", user: false, at: 104),
        ]
        #expect(ChatWorkPlacement.anchor(for: t0.addingTimeInterval(3), in: turns) == "a1")
        #expect(ChatWorkPlacement.anchor(for: t0.addingTimeInterval(102), in: turns) == "a2")
        // Composed after both: still the newest question's reply.
        #expect(ChatWorkPlacement.anchor(for: t0.addingTimeInterval(500), in: turns) == "a2")
    }

    /// A question with no reply yet holds the task itself; a task older than
    /// every question goes to the transcript's foot.
    @Test
    func theEdges() {
        let unanswered = [turn("q1", user: true, at: 0)]
        #expect(ChatWorkPlacement.anchor(for: t0.addingTimeInterval(1), in: unanswered) == "q1")
        #expect(ChatWorkPlacement.anchor(for: t0.addingTimeInterval(-60), in: unanswered) == nil)
        #expect(ChatWorkPlacement.anchor(for: t0, in: []) == nil)
    }

    /// Only a sentence that opens with "Juno " is re-voiced for an agent.
    @Test
    func anAgentsNameReplacesJunoOnlyWhereJunoIsTheSubject() {
        #expect(ChatWorkVocabulary.sentence(.running, actor: "Ada") == "Ada is working on this now.")
        #expect(ChatWorkVocabulary.sentence(.waitingInput, actor: "Ada")
            == "Ada has asked you something and cannot continue until you answer.")
        #expect(ChatWorkVocabulary.sentence(.completed, actor: "Ada") == "This finished.")
        #expect(ChatWorkVocabulary.sentence(.running, actor: nil) == "Juno is working on this now.")
    }

    /// The web's number formats, which the meter and the queue use.
    @Test
    func theWebsFormats() {
        #expect(ChatWorkFormat.duration(0) == "0s")
        #expect(ChatWorkFormat.duration(0.24) == "240ms")
        #expect(ChatWorkFormat.duration(42) == "42s")
        #expect(ChatWorkFormat.duration(263) == "4m 23s")
        #expect(ChatWorkFormat.duration(3_900) == "1h 5m")
        #expect(ChatWorkFormat.cost(microUsd: 0) == "$0.00")
        #expect(ChatWorkFormat.cost(microUsd: 187_400) == "$0.19")
        #expect(ChatWorkFormat.tokens(940) == "940")
        #expect(ChatWorkFormat.tokens(4_207) == "4.2K")
        #expect(ChatWorkFormat.tokens(43_119) == "43K")
        #expect(ChatWorkFormat.tokens(1_204_000) == "1.20M")
        #expect(ChatWorkFormat.ago(t0, now: t0.addingTimeInterval(30)) == "just now")
        #expect(ChatWorkFormat.ago(t0, now: t0.addingTimeInterval(125)) == "2m ago")
        #expect(ChatWorkFormat.ago(t0, now: t0.addingTimeInterval(86_400 * 1.5)) == "yesterday")
    }

    /// Try Again is offered where the task ended without finishing.
    @Test
    func tryAgainIsForAnEndThatWasNotFinishing() {
        #expect(ChatWorkVocabulary.canTryAgain(.failed))
        #expect(ChatWorkVocabulary.canTryAgain(.hostOffline))
        #expect(!ChatWorkVocabulary.canTryAgain(.completed))
        #expect(!ChatWorkVocabulary.canTryAgain(.running))
    }
}

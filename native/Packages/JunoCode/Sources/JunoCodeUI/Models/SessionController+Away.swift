import Foundation
import JunoCodeCore
import JunoCodeRuntime

// What a reader who looked away can do without opening the session: answer
// an approval or a question from the Runs list or a notification, keep a
// stopped run going, and resume a run Juno quit in the middle of
// (CODE_AGENT_SPEC §1.11, §1.12, §5.1). Owned by Lane E.

public extension SessionController {
    /// Juno quit or crashed while this session's run was working.
    var isInterrupted: Bool { RunIndex.isInterrupted(session) }

    /// The calls that were running when Juno quit, whose results nobody saw:
    /// each one's summary, for the note Resume sends.
    var interruptedCallSummaries: [String] {
        var summaries: [String: String] = [:]
        for event in events {
            if case let .toolProposed(proposed) = event.payload {
                summaries[proposed.toolCallID] = proposed.summary
            }
        }
        return ConversationIntegrity.interruptedCalls(in: events)
            .compactMap { id, state in state == .started ? summaries[id] ?? id : nil }
            .sorted()
    }

    /// Resume after quit: carries on with a runtime note naming the calls
    /// whose outcome is unknown, and no new message from the reader. The same
    /// path as the thread's Resume row (Lane A's `resumeInterruptedRun`).
    @discardableResult
    func resumeInterrupted() async -> Bool {
        await resumeInterruptedRun()
    }

    // Keep going is Lane A's `keepGoing()` (SessionController+Autonomy): it
    // also gives a goal that hit its budget or needed the reader another
    // block, and answers whether the run carried on.

    /// Re-enters the run on the saved conversation with a runtime note.
    /// Refused while a run, a rewind or a compaction holds the session.
    @discardableResult
    func resumeRun(note: RuntimeNote, origin: TurnOrigin) async -> Bool {
        guard let live, !isRunning, !isRewinding, !isCompacting else { return false }
        do {
            try await currentOrchestrator(live).resume(note: note, origin: origin)
            return true
        } catch {
            return false
        }
    }

    /// Allow once, from outside the session. Only when that exact approval is
    /// still pending with that digest: an answer meant for one action never
    /// carries out another, and a stale banner is refused. Never a screen
    /// card (``isAllowedOnlyOnItsCard(approvalID:)``).
    @discardableResult
    func allowOnce(approvalID: String, digest: String) async -> Bool {
        await resolveFromOutside(approvalID: approvalID, digest: digest, decision: .approved)
    }

    /// Decline, from outside the session, under the same digest check.
    @discardableResult
    func declineApproval(approvalID: String, digest: String) async -> Bool {
        await resolveFromOutside(approvalID: approvalID, digest: digest, decision: .denied)
    }

    /// Whether this pending approval is a screen card, which is allowed only
    /// on the card in the session (CU-07, Lane C): a banner or a Runs row
    /// shows the sentence, not the frame with the target marked, and the
    /// grant sheet's unticks are settled on the card before its Allow
    /// (`approve`). Declining one from anywhere stays open.
    func isAllowedOnlyOnItsCard(approvalID: String) async -> Bool {
        guard let live,
              let request = await live.permissions.pendingApprovals.first(where: { $0.id == approvalID })
        else { return false }
        return ComputerUseToolName.allowedOnlyAtTheMac.contains(request.toolName)
    }

    private func resolveFromOutside(approvalID: String, digest: String, decision: ApprovalDecision) async -> Bool {
        guard let live else { return false }
        let pending = await live.permissions.pendingApprovals
        guard let request = pending.first(where: { $0.id == approvalID && $0.actionDigest == digest }) else {
            return false
        }
        if decision == .approved, ComputerUseToolName.allowedOnlyAtTheMac.contains(request.toolName) {
            return false
        }
        await live.permissions.resolve(approvalID: approvalID, decision: decision)
        return true
    }

    /// Answers the first question of a pending `ask_user` with words.
    @discardableResult
    func reply(toQuestion requestID: String, text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let live, !trimmed.isEmpty else { return false }
        let pending = await live.questions.pendingQuestions
        guard let request = pending.first(where: { $0.id == requestID }),
              let first = request.questions.first
        else { return false }
        await live.questions.answer(
            requestID: requestID,
            answers: [QuestionAnswer(questionID: first.id, text: trimmed)]
        )
        return true
    }
}

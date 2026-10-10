import Foundation
import JunoCodeBridge
import JunoCodeCore
import JunoCodeRuntime

// Conversations messaging each other: a message from another of the reader's
// conversations, arriving in this session (src/lib/cross-conversation).

public extension SessionController {
    /// Records the message and gives it a turn of its own: now when the
    /// session is idle, after the running turn (or the approval it waits on)
    /// otherwise. Never steered into a running turn, never an answer to an
    /// approval, never a change of mode: the turn runs under the session's own
    /// permission mode, with the message fenced as data.
    ///
    /// Returns "started", "queued" or "noted" (an idle notice); throws when
    /// this session does not take messages from other conversations.
    func deliverConversationMessage(_ delivery: CodeConversationDelivery) async throws -> String {
        if !delivery.notice, !CodeDefaults.shared.crossMessagesEnabled(forSession: sessionID.value) {
            await CodeConversationHub.shared.report(linkID: delivery.linkID, status: "failed", error: "This session does not accept messages from other conversations.")
            throw RemotePromptRefusal(message: "This session does not accept messages from other conversations.")
        }
        if !delivery.notice, delivery.hop >= CodeCrossConversation.maxHops {
            throw RemotePromptRefusal(message: "This exchange between conversations has reached its limit.")
        }
        guard live != nil else {
            throw RemotePromptRefusal(message: "This session cannot run on this Mac right now.")
        }
        let event = ConversationMessageEvent(
            direction: delivery.notice ? .notice : .received,
            peerRef: delivery.fromRef,
            peerTitle: delivery.fromTitle,
            peerProduct: delivery.fromProduct,
            text: delivery.notice ? "Idle again." : delivery.text,
            hop: delivery.hop,
            chainID: delivery.chainID,
            linkID: delivery.linkID
        )
        let framed = delivery.notice
            ? CodeCrossConversation.idleNotice(targetTitle: delivery.fromTitle, targetRef: delivery.fromRef)
            : CodeCrossConversation.frame(
                fromTitle: delivery.fromTitle, fromRef: delivery.fromRef,
                fromProduct: delivery.fromProduct, hop: delivery.hop, text: delivery.text
            )
        noteCrossMessageArrived()
        if !isRunning, await startConversationTurn(framed: framed, event: event, delivery: delivery) {
            return delivery.notice ? "noted" : "started"
        }
        // Busy: wait for the session to be free, then take its turn.
        Task { [weak self] in
            for _ in 0..<1_800 {
                try? await Task.sleep(for: .seconds(1))
                guard let self else { return }
                if !self.isRunning, await self.startConversationTurn(framed: framed, event: event, delivery: delivery) { return }
            }
            await CodeConversationHub.shared.report(linkID: delivery.linkID, status: "failed", error: "The session stayed busy.")
        }
        return "queued"
    }

    /// The sidebar's unread title for this session, until the reader opens it.
    func noteCrossMessageArrived() {
        CodeCrossInbox.shared.arrived(sessionID)
    }

    private func startConversationTurn(framed: String, event: ConversationMessageEvent, delivery: CodeConversationDelivery) async -> Bool {
        guard let live, !isRunning, !isRewinding, !isCompacting else { return false }
        do {
            CodeConversationHub.shared.setChain(CodeConversationChain(chainID: delivery.chainID, hop: delivery.hop), for: sessionID)
            try await currentOrchestrator(live).continueWithConversationMessage(framed, event: event)
        } catch {
            return false
        }
        await CodeConversationHub.shared.report(linkID: delivery.linkID, status: "delivered")
        // The turn this message started: report it answered once it ends, so
        // a sender that asked hears the session is idle again.
        if let linkID = delivery.linkID, !delivery.notice {
            Task { [weak self] in
                for _ in 0..<7_200 {
                    try? await Task.sleep(for: .seconds(1))
                    guard let self else { return }
                    if !self.isRunning { break }
                }
                await CodeConversationHub.shared.report(linkID: linkID, status: "answered")
            }
        }
        return true
    }
}

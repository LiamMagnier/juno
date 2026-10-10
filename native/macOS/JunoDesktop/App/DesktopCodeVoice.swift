import JunoCodeCore
import JunoCodeUI
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

// MARK: - Dictation

/// Dictation for Code's composers, built from Chat's own parts.
///
/// Chat dictates inside its composer's shell (``ComposerDictationField`` in the
/// field slot, ``ComposerDictationControls`` in the controls row,
/// ``ComposerDictationGlow`` on the edge). Code's composer takes this as
/// `CodeComposerSpeech.dictation` and draws it in its shell in place of both,
/// and the host hands the glow in as the shell's edge light, so Code dictates
/// exactly where and as Chat does: no second card, nothing over the composer.
/// Same words, same meter, same exits (✕ and ✓ Done, no second send disc) and
/// the same keys: Esc cancels, Return sends what was heard, Done puts it in
/// the draft.
///
/// The host owns the take (``ComposerDictationSession``) and starts it, so the
/// field, the row and the glow all read the one recogniser.
struct DesktopCodeDictation: View {
    let session: ComposerDictationSession
    let onCancel: () -> Void
    let onStop: (String) -> Void
    let onSend: (String) -> Void

    @FocusState private var focused: Bool

    var body: some View {
        // Inside the composer's own shell, in place of its field and its row,
        // as Chat's composer dictates: no second card, nothing over the page.
        VStack(alignment: .leading, spacing: 0) {
            ComposerDictationField(session: session)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.cozy + 2)
                .padding(.bottom, JunoSpace.snug)
            ComposerDictationControls(session: session, cancel: cancel, done: stop)
                .padding(.horizontal, JunoSpace.snug)
            .padding(.bottom, JunoSpace.snug)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.escape) {
            cancel()
            return .handled
        }
        .onKeyPress(.return, phases: .down) { _ in
            if session.hasWords { send() }
            return .handled
        }
        .onAppear { focused = true }
        // A recogniser left running with nothing on screen is a live
        // microphone nobody can see.
        .onDisappear { if session.phase != .finished { session.cancel() } }
        .accessibilityIdentifier("juno.code.dictation")
    }

    private func cancel() {
        session.cancel()
        onCancel()
    }

    private func stop() {
        onStop(session.finish())
    }

    private func send() {
        let heard = session.finish()
        if heard.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            onCancel()
        } else {
            onSend(heard)
        }
    }
}

// MARK: - Voice: the call talks to the thread

/// What a Code call does with the conversation, as a value the tests read.
///
/// Every finished sentence the reader speaks becomes the thread's next turn,
/// through the composer's own send (a new turn, or a steer or queued follow-up
/// while a run works). When a run the call is following finishes, its reply
/// is handed to the voice model to say back, the way Chat's call answers out
/// loud. The read-back prompt rides the socket as a user line and comes back
/// in the transcript, so it is recognised and never forwarded.
struct DesktopCodeVoiceRelay: Equatable {
    /// What the call asks the voice model when a reply is ready.
    static let readBackPrompt = "Tell me what Alevr Code just said."

    private(set) var forwarded: Set<UUID> = []
    private(set) var lastSpoken: String?

    /// Final sentences the reader said that have not gone to the thread yet.
    mutating func requests(in lines: [JunoRealtimeVoiceController.TranscriptLine]) -> [String] {
        var out: [String] = []
        for line in lines where line.role == .user && line.final && !forwarded.contains(line.id) {
            forwarded.insert(line.id)
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, text != Self.readBackPrompt else { continue }
            out.append(text)
        }
        return out
    }

    /// The reply to say once a run stops: the newest assistant text, once.
    mutating func reply(wasRunning: Bool, isRunning: Bool, latest: String?) -> String? {
        guard wasRunning, !isRunning else { return nil }
        guard let text = latest?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
              text != lastSpoken
        else { return nil }
        lastSpoken = text
        return text
    }

    /// The context a reply is read back with, bounded to what the socket takes.
    static func readBackContext(_ reply: String) -> String {
        String("Alevr Code's reply to the reader, to say back briefly and naturally:\n\(reply)"
            .prefix(JunoVoiceHistoryEntry.maximumContextCharacters))
    }
}

/// What the voice model is told when a Code call starts: where the thread
/// runs and what has happened in it, most recent last. The relay's own system
/// prompt is "you are Alevr on a call"; this says what the call is for.
enum DesktopCodeVoiceBriefing {
    static func history(place: String?, turns: [(role: JunoVoiceTranscriptRole, text: String)]) -> [JunoVoiceHistoryEntry] {
        let whereLine = place.map { " in \($0)" } ?? ""
        let arrangement = "This call is the reader's voice for Alevr Code, a coding agent working\(whereLine). "
            + "Everything the reader says here is sent to Alevr Code as their next instruction. "
            + "Acknowledge each request in a few words and do not claim to have done the work yourself. "
            + "When Alevr Code replies, you will be given its reply to say back briefly."
        var entries = [JunoVoiceHistoryEntry(role: .user, text: arrangement)]
        entries += turns.suffix(8).map { JunoVoiceHistoryEntry(role: $0.role, text: String($0.text.prefix(600))) }
        return JunoVoiceHistoryEntry.bounded(entries)
    }

    /// An Alevr-engine thread's turns, from its events.
    static func turns(_ events: [SessionEvent]) -> [(role: JunoVoiceTranscriptRole, text: String)] {
        events.compactMap { event in
            switch event.payload {
            case let .userPrompt(prompt): (.user, prompt.text)
            case let .userInstruction(instruction): (.user, instruction.text)
            case let .assistantMessage(message): (.assistant, message.text)
            default: nil
            }
        }
    }

    /// An env-server thread's turns, from its items.
    static func turns(_ items: [CodeV2.TurnItem]) -> [(role: JunoVoiceTranscriptRole, text: String)] {
        items.compactMap { item in
            switch item {
            case let .userMessage(message): (.user, message.text)
            case let .assistantMessage(message): (.assistant, message.text)
            default: nil
            }
        }
    }

    static func latestReply(_ events: [SessionEvent]) -> String? {
        turns(events).last(where: { $0.role == .assistant })?.text
    }

    static func latestReply(_ items: [CodeV2.TurnItem]) -> String? {
        turns(items).last(where: { $0.role == .assistant })?.text
    }
}

/// Joins a live call to the Code thread on screen: forwards what the reader
/// says, and reads the thread's reply back when a run finishes.
struct DesktopCodeVoiceLink: ViewModifier {
    let controller: JunoRealtimeVoiceController?
    let isRunning: Bool
    let latestReply: String?
    let deliver: (String) -> Void

    @State private var relay = DesktopCodeVoiceRelay()

    func body(content: Content) -> some View {
        content
            .onChange(of: controller?.transcript ?? []) { _, lines in
                for request in relay.requests(in: lines) { deliver(request) }
            }
            .onChange(of: isRunning) { was, now in
                guard let controller,
                      let reply = relay.reply(wasRunning: was, isRunning: now, latest: latestReply)
                else { return }
                Task {
                    await controller.sendTurn(
                        text: DesktopCodeVoiceRelay.readBackPrompt,
                        images: [],
                        context: DesktopCodeVoiceRelay.readBackContext(reply)
                    )
                }
            }
    }
}

extension View {
    /// The call, if one is live, joined to the Code thread this view shows.
    func codeVoiceLink(
        _ controller: JunoRealtimeVoiceController?,
        isRunning: Bool,
        latestReply: String?,
        deliver: @escaping (String) -> Void
    ) -> some View {
        modifier(DesktopCodeVoiceLink(controller: controller, isRunning: isRunning, latestReply: latestReply, deliver: deliver))
    }
}

import JunoCodeCore
import JunoCodeUI
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

// MARK: - Dictation

/// Dictation for Code's composers, built from Chat's own parts.
///
/// Chat dictates inside its composer's shell (``ComposerDictationField`` in the
/// field slot, ``ComposerDictationControls`` in the controls row). Code's
/// composer lives in the JunoCode package and cannot hold those app-side
/// views, so this lays the same two parts in a shell of the composer's shape,
/// over the composer, for as long as the reader dictates. Same words, same
/// meter, same exits and the same keys: Esc cancels, Return sends what was
/// heard, Done puts it in the draft.
struct DesktopCodeDictation: View {
    let onCancel: () -> Void
    let onStop: (String) -> Void
    let onSend: (String) -> Void

    @State private var session = ComposerDictationSession()
    @FocusState private var focused: Bool

    var body: some View {
        JunoDesktopGlass(spacing: JunoSpace.hairline) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                ComposerDictationField(session: session)
                    .padding(.horizontal, JunoSpace.tight)
                    .padding(.top, JunoSpace.tight)
                ComposerDictationControls(session: session, cancel: cancel, stop: stop) {
                    ComposerPrimaryDisc(
                        face: session.hasWords ? .send : .disabled("Send what you dictated"),
                        label: "Send what you dictated",
                        identifier: "juno.code.dictation-send",
                        action: send
                    )
                }
            }
            .padding(JunoSpace.snug)
            .frame(maxWidth: .infinity, alignment: .leading)
            .junoGlass(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
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
        .task { await session.begin() }
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

/// Dictation over a Code surface's composer while the reader dictates. What
/// was heard goes back to the composer as ``CodeHeardText``.
struct DesktopCodeDictationLayer: ViewModifier {
    @Binding var isDictating: Bool
    @Binding var heard: CodeHeardText?

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if isDictating {
                DesktopCodeDictation(
                    onCancel: { close() },
                    onStop: { words in
                        heard = CodeHeardText(text: words, disposition: .append)
                        close()
                    },
                    onSend: { words in
                        heard = CodeHeardText(text: words, disposition: .appendAndSend)
                        close()
                    }
                )
                .frame(maxWidth: Studio.Metrics.measure)
                .padding(.horizontal, Studio.Metrics.gutter)
                .padding(.bottom, JunoSpace.regular)
                .transition(.opacity)
            }
        }
    }

    private func close() {
        withAnimation(JunoMotion.fast) { isDictating = false }
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

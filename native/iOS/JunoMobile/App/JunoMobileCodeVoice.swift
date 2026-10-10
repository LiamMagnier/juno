import JunoCodeKit
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

// Voice, dictation and the mode for Code's composers on the phone (owner,
// 2026-10-10), the same arrangement as the Mac and the web:
//
// - the microphone is Chat's dictation (`JunoMobileDictation`): cancel, stop
//   into the draft, or send;
// - voice is a call whose every finished sentence becomes the thread's next
//   turn on its own, and whose run's reply is read back when it finishes;
// - the mode is one chip: Ask, Accept edits, Auto, Plan, Full access, each
//   with its line, as far as the road into the run can carry it.

// MARK: - The call joined to a thread

/// What a Code call does with the conversation, as a value the tests read:
/// the Mac's `DesktopCodeVoiceRelay`, on the phone.
struct JunoMobileCodeVoiceRelay: Equatable {
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

    static func readBackContext(_ reply: String) -> String {
        String("Alevr Code's reply to the reader, to say back briefly and naturally:\n\(reply)"
            .prefix(JunoVoiceHistoryEntry.maximumContextCharacters))
    }

    /// What the voice model is told when a Code call starts.
    static func briefing(place: String?, turns: [(role: JunoVoiceTranscriptRole, text: String)]) -> [JunoVoiceHistoryEntry] {
        let whereLine = place.map { " in \($0)" } ?? ""
        let arrangement = "This call is the reader's voice for Alevr Code, a coding agent working\(whereLine). "
            + "Everything the reader says here is sent to Alevr Code as their next instruction. "
            + "Acknowledge each request in a few words and do not claim to have done the work yourself. "
            + "When Alevr Code replies, you will be given its reply to say back briefly."
        var entries = [JunoVoiceHistoryEntry(role: .user, text: arrangement)]
        entries += turns.suffix(8).map { JunoVoiceHistoryEntry(role: $0.role, text: String($0.text.prefix(600))) }
        return JunoVoiceHistoryEntry.bounded(entries)
    }
}

/// Starts a Code call: the shell builds the session (it holds the credential)
/// and hands it to Code's composers through the environment.
typealias JunoMobileCodeVoiceStarter = @MainActor (_ history: [JunoVoiceHistoryEntry]) -> Void

extension EnvironmentValues {
    /// Starts a Code call. Nil draws no voice button (signed out, no plan).
    @Entry var junoStartCodeVoice: JunoMobileCodeVoiceStarter?
    /// The live call when it was started from Code. A call started from Chat
    /// is never joined to a Code thread.
    @Entry var junoCodeVoiceSession: JunoMobileVoiceSession?
}

/// Joins the live Code call to the thread on screen.
struct JunoMobileCodeVoiceLink: ViewModifier {
    let session: JunoMobileVoiceSession?
    let isRunning: Bool
    let latestReply: String?
    /// False while another Code screen is on top: the sentence is that
    /// screen's, so this one lets it pass (and never sends it later).
    var enabled = true
    let deliver: (String) -> Void

    @State private var relay = JunoMobileCodeVoiceRelay()

    func body(content: Content) -> some View {
        content
            .onChange(of: session?.controller.transcript ?? []) { _, lines in
                let requests = relay.requests(in: lines)
                guard enabled else { return }
                for request in requests { deliver(request) }
            }
            .onChange(of: isRunning) { was, now in
                guard enabled, let controller = session?.controller,
                      let reply = relay.reply(wasRunning: was, isRunning: now, latest: latestReply)
                else { return }
                Task {
                    _ = await controller.sendTurn(
                        text: JunoMobileCodeVoiceRelay.readBackPrompt,
                        images: [],
                        context: JunoMobileCodeVoiceRelay.readBackContext(reply)
                    )
                }
            }
    }
}

extension View {
    func junoCodeVoiceLink(
        _ session: JunoMobileVoiceSession?,
        isRunning: Bool,
        latestReply: String?,
        enabled: Bool = true,
        deliver: @escaping (String) -> Void
    ) -> some View {
        modifier(JunoMobileCodeVoiceLink(
            session: session, isRunning: isRunning, latestReply: latestReply, enabled: enabled, deliver: deliver
        ))
    }
}

/// The live Code call, above the composer while it lasts: what it is doing,
/// the way back to the full-screen call, and End.
struct JunoMobileCodeCallBar: View {
    let session: JunoMobileVoiceSession

    private var phaseLine: String {
        if session.controller.muted { return "Muted" }
        if session.controller.phase != .live { return "Connecting" }
        return "Each sentence you finish goes to this session"
    }

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(.audioLines, size: 15)
                .foregroundStyle(Color.junoSecondaryInk)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Voice")
                    .font(.subheadline.weight(.medium))
                Text(phaseLine)
                    .font(.footnote)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(1)
            }
            Spacer(minLength: JunoSpace.hairline)
            Button {
                session.isFullScreen = true
            } label: {
                JunoIconView(.maximize, size: 15)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open the call")
            Button(role: .destructive) {
                session.hangUp()
            } label: {
                Text("End")
                    .font(.subheadline.weight(.medium))
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("juno.mobile.code-voice-end")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .junoMobileRaised(cornerRadius: 18)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.mobile.code-voice-bar")
    }
}

// MARK: - The composer's buttons

/// The microphone and the voice button, before Send: Chat's order.
struct JunoMobileCodeSpeechButtons: View {
    var dictate: (() -> Void)?
    var talk: (() -> Void)?
    var isEnabled = true

    var body: some View {
        if let dictate {
            Button(action: dictate) {
                JunoIconView(.mic, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!isEnabled)
            .accessibilityLabel("Dictate")
            .accessibilityIdentifier("juno.mobile.code-dictate")
        }
        if let talk {
            Button(action: talk) {
                JunoIconView(.audioLines, size: 16)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!isEnabled)
            .accessibilityLabel("Start voice conversation")
            .accessibilityIdentifier("juno.mobile.code-voice")
        }
    }
}

// MARK: - The mode

extension CodeComposerModeLadder {
    /// The web icon set's glyph for the rung.
    var icon: JunoIcon {
        switch self {
        case .ask: .hand
        case .acceptEdits: .pencil
        case .auto: .shield
        case .plan: .listChecks
        case .full: .lockOpen
        }
    }
}

/// The mode, as one chip on the composer's row: the rungs the road into the
/// run can carry, each with its line, the current one checked.
struct JunoMobileCodeModeChip: View {
    let mode: CodeComposerModeLadder
    let offered: [CodeComposerModeLadder]
    /// Said under the rungs: why some are missing, or what decides the mode.
    var note: String?
    var isEnabled = true
    let choose: (CodeComposerModeLadder) -> Void

    var body: some View {
        Menu {
            Section {
                ForEach(offered) { rung in
                    Button {
                        choose(rung)
                    } label: {
                        if rung == mode {
                            Label {
                                Text(rung.title)
                                Text(rung.detail)
                            } icon: {
                                Image(JunoIcon.check.assetName(.regular))
                            }
                        } else {
                            Text(rung.title)
                            Text(rung.detail)
                        }
                    }
                }
            } footer: {
                if let note { Text(note) }
            }
        } label: {
            // The name when the row has room for it, the glyph when it does
            // not (the web hides the word on a narrow composer the same way).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: JunoSpace.hairline + 2) {
                    JunoIconView(mode.icon, size: 14)
                    Text(mode.title)
                        .lineLimit(1)
                        .fixedSize()
                    JunoIconView(.chevronDown, size: 10)
                        .foregroundStyle(Color.junoTertiaryInk)
                }
                HStack(spacing: JunoSpace.hairline + 2) {
                    JunoIconView(mode.icon, size: 14)
                    JunoIconView(.chevronDown, size: 10)
                        .foregroundStyle(Color.junoTertiaryInk)
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.horizontal, JunoSpace.snug)
            .frame(minHeight: 44)
            .contentShape(.hoverEffect, .rect(cornerRadius: 10))
            .hoverEffect(.highlight)
        }
        .tint(Color.primary)
        .disabled(!isEnabled)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .accessibilityLabel("Mode, \(mode.title)")
        .accessibilityHint(mode.detail)
        .accessibilityIdentifier("juno.mobile.code-mode")
    }
}

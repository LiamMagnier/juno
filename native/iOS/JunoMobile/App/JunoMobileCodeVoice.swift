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

// MARK: - The composer

// Dictation is Chat's own (`JunoMobileDictation.swift`): one
// `JunoMobileDictationSession` per take, `JunoMobileDictationTranscript` in
// the field's slot, `JunoMobileDictationRow` in the accessory row's slot and
// `JunoVoiceGlow` in your ink on the card's edge, so Chat and Code are one.

/// A Code composer in the iOS Chat composer's anatomy (the one the owner
/// approved): one Liquid Glass card, radius 24, the field on top and one
/// accessory row under it.
///
/// - At rest the row holds the surface's chips, then the microphone, then one
///   primary circle that changes face: voice when nothing is typed, Send once
///   something is, Stop while a run works and nothing is typed.
/// - Dictating, the field shows the live words and the row becomes cancel,
///   the level and done, in place.
/// - In a call, the composer is the call, as on the web: "Type while you
///   talk…", the call's controls, End in Send's place, and the warm glow
///   rising through the glass. Every finished sentence goes to the thread.
struct JunoMobileCodeComposer<Accessories: View>: View {
    @Binding var text: String
    let placeholder: String
    var focused: FocusState<Bool>.Binding
    var voice: JunoMobileVoiceSession?
    var canSend: Bool
    var isRunning = false
    let send: () -> Void
    var stop: (() -> Void)?
    var startVoice: (() -> Void)?
    /// Opens with this dictation showing: the offscreen snapshots only.
    var previewDictation: JunoMobileDictationSession?
    @ViewBuilder var accessories: () -> Accessories

    @State private var dictation: JunoMobileDictationSession?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private static var typeWhileYouTalk: String { "Type while you talk\u{2026}" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            field
            row
                .padding(.horizontal, JunoSpace.tight)
                .padding(.bottom, JunoSpace.tight)
        }
        .junoGlass(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        // The card's own edge carries the light, as Chat's composer does: the
        // call's while one is live, your ink while you dictate.
        .overlay {
            if let voice {
                JunoMobileVoiceComposerGlow(session: voice)
                    .transition(.opacity)
            } else if let dictation {
                JunoVoiceGlow(
                    mode: dictation.isListening ? .you : .off,
                    you: { [dictation] in dictation.level },
                    cornerRadius: 24
                )
                .transition(.opacity)
            }
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: dictation == nil)
        .onAppear { if let previewDictation { dictation = previewDictation } }
        .onDisappear { dictation?.cancel() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(voice == nil ? Text("Message composer") : Text("Voice call"))
    }

    @ViewBuilder
    private var field: some View {
        if let dictation {
            JunoMobileDictationTranscript(session: dictation, draft: text)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.comfy)
                .padding(.bottom, JunoSpace.tight)
                .transition(.opacity)
        } else {
            TextField(
                text: $text,
                prompt: Text(voice != nil ? Self.typeWhileYouTalk : placeholder)
                    .foregroundStyle(Color.secondary),
                axis: .vertical
            ) {
                Text(voice != nil ? Self.typeWhileYouTalk : placeholder)
            }
            .junoFont(size: 17, relativeTo: .body)
            .lineLimit(1...6)
            .textFieldStyle(.plain)
            .focused(focused)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.comfy)
            .padding(.bottom, JunoSpace.tight)
            .accessibilityIdentifier("juno.mobile.code-composer-field")
        }
    }

    @ViewBuilder
    private var row: some View {
        HStack(spacing: JunoSpace.hairline) {
            if let dictation {
                JunoMobileDictationRow(
                    session: dictation,
                    onCancel: {
                        dictation.cancel()
                        self.dictation = nil
                    },
                    onDone: {
                        text = JunoMobileCodeView.joined(text, dictation.finish())
                        self.dictation = nil
                        focused.wrappedValue = true
                    }
                )
                .transition(JunoMobileComposer.dictationRowTransition(reduceMotion))
            } else if let voice {
                Spacer(minLength: 0)
                JunoMobileVoiceCallControls(session: voice)
                if isEmpty {
                    Button {
                        voice.hangUp()
                    } label: {
                        JunoIconView(.phoneOff, size: 16)
                            .foregroundStyle(Color.junoCanvas)
                            .frame(width: 36, height: 36)
                            .modifier(JunoComposerSendBackground(active: true, tint: Color.junoDanger))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("End the call")
                    .accessibilityIdentifier("juno.mobile.code-voice-end")
                } else {
                    JunoMobileComposerPrimaryButton(face: .send(enabled: canSend), action: send)
                }
            } else {
                accessories()
                Spacer(minLength: JunoSpace.hairline)
                if JunoSpeechService.isSupported {
                    Button(action: beginDictation) {
                        JunoIconView(.mic, size: 20)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dictate")
                    .accessibilityIdentifier("juno.mobile.code-dictate")
                }
                JunoMobileComposerPrimaryButton(face: primaryFace) {
                    switch primaryFace {
                    case .stop: stop?()
                    case .voice: startVoice?()
                    case .send: send()
                    }
                }
                .accessibilityIdentifier("juno.mobile.code-primary")
            }
        }
    }

    private var primaryFace: JunoMobileComposerPrimaryButton.Face {
        if isEmpty, isRunning, stop != nil { return .stop }
        if isEmpty, startVoice != nil { return .voice }
        return .send(enabled: canSend)
    }

    private func beginDictation() {
        focused.wrappedValue = false
        let take = JunoMobileDictationSession()
        dictation = take
        Task { await take.start() }
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

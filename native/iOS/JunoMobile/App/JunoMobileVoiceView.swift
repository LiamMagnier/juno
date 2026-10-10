import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI
import UIKit

// A voice call, in the composer (the website's design: the call is the
// composer, not a screen of its own).
//
// Host usage, for any iPhone composer card (Chat's `JunoMobileComposer` is
// the reference). The session arrives through `\.junoVoiceSession`:
//
//     // placeholder while in a call: "Type while you talk…"
//     // accessory row, replacing the host's own row (never beside it):
//     HStack {
//         plusMenu                                   // the host's `+`
//         Spacer()
//         JunoMobileVoiceCallControls(session: call) // [stop] mic screen settings
//         if draft.isEmpty { JunoMobileVoiceCallEnd(session: call) } else { sendButton }
//     }
//     // on the card's edge:
//     .overlay { JunoMobileVoiceComposerGlow(session: call, cornerRadius: 24) }
//     // one quiet line above the card:
//     JunoMobileVoiceCallNotices(session: call)

/// One spoken conversation, handed to the chat column through the environment.
///
/// A `@MainActor` class rather than a struct of closures, for two reasons. The
/// identity is what lets SwiftUI tell one call from the next without comparing
/// closures it cannot compare; and a globally-isolated class is `Sendable`
/// whatever it stores, which the same fields in a struct are not.
///
/// It travels through the environment because the composer is several files
/// below the shell that authorizes a session — the chat screen in between owns
/// neither and should not have to carry it.
@MainActor
@Observable
final class JunoMobileVoiceSession: Identifiable {
    /// Stable for the life of this call. The save route is idempotent per
    /// session, so a retry after a dropped network updates the same conversation
    /// instead of creating a second one.
    let id = UUID()
    /// When the call began. It exists to date the transient rows in
    /// ``liveMessages(conversationID:)`` with something that does not change on
    /// every read — see the note there.
    let startedAt = Date()
    let controller: JunoRealtimeVoiceController
    let accountID: AccountID
    /// Authenticated durable document retrieval for files shared during Voice.
    /// Nil only in the unauthenticated preview shell, where the file action is
    /// not offered.
    let attachmentContextClient: NativeVoiceAttachmentContextClient?
    /// Files the spoken turns into a chat. Nil where nothing can be saved — an
    /// unconfigured shell, in which case the composer says so on the way out rather
    /// than dropping the conversation in silence.
    let saveTranscript: ((JunoMobileVoiceTranscript) async -> String?)?
    /// Drops the session from the shell. Called once the transcript is filed, or
    /// straight away when there is nothing to file.
    let close: () -> Void
    /// The camera and the screen share, owned by the call rather than by the
    /// composer, so the full-screen mode and the composer show the same picture and
    /// neither can start a second capture the other cannot see.
    let camera = JunoMobileVoiceCamera()
    let screenShare = JunoMobileVoiceScreenShare()
    /// Interruptions and route changes, watched for the life of the call.
    let audioSession: JunoMobileVoiceAudioSession
    /// Set by the hang-up while it files the transcript; read by both surfaces.
    var isSaving = false
    var saveError: String?

    init(
        controller: JunoRealtimeVoiceController,
        accountID: AccountID,
        attachmentContextClient: NativeVoiceAttachmentContextClient?,
        saveTranscript: ((JunoMobileVoiceTranscript) async -> String?)?,
        close: @escaping () -> Void
    ) {
        self.controller = controller
        self.accountID = accountID
        self.attachmentContextClient = attachmentContextClient
        self.saveTranscript = saveTranscript
        self.close = close
        self.audioSession = JunoMobileVoiceAudioSession(controller: controller)
    }

    /// Hang up, then file the conversation.
    ///
    /// **In that order, and the order is the point.** `end()` first, so the
    /// microphone and the socket are down the instant the reader asks — waiting
    /// on a network round trip with a live mic is the one thing a hang-up must
    /// never do. The save then runs against the transcript the controller
    /// already holds, and End shows a spinner while it does,
    /// because closing first would leave a failed save with nowhere to report.
    func hangUp() {
        camera.stop()
        screenShare.stop()
        controller.end()
        guard let saveTranscript, !savableTurns.isEmpty else {
            close()
            return
        }
        isSaving = true
        saveError = nil
        Task {
            let saved = await saveTranscript(
                JunoMobileVoiceTranscript(sessionID: id, turns: savableTurns)
            )
            isSaving = false
            guard saved != nil else {
                saveError = String(localized: "voice.save.failed")
                return
            }
            close()
        }
    }

    /// The finished lines, in order. Non-final lines are dropped: they are
    /// live hypotheses the recognizer is still rewriting, and saving one puts a
    /// half-heard sentence into the reader's permanent history.
    var savableTurns: [NativeVoiceTranscriptClient.Turn] {
        controller.transcript.compactMap { line in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.final, !text.isEmpty else { return nil }
            return NativeVoiceTranscriptClient.Turn(
                role: line.role == .assistant ? .assistant : .user,
                content: text,
                attachmentIDs: line.attachmentIDs
            )
        }
    }

    /// True once audio is actually flowing. The one test worth sharing: the
    /// composer routes a typed turn through the relay only from here, and the
    /// call's Stop is offered only from here.
    var isLive: Bool { controller.phase == .live }

    /// **The call as it is being spoken, as ordinary chat messages.**
    ///
    /// The web's `voiceMessages` (`chat-view.tsx`), ported: spoken turns are
    /// appended after the persisted ones and rendered as ordinary bubbles,
    /// marked still-streaming until the recognizer settles them. There is no
    /// transcript pane on either client, and this is why — the words belong in
    /// the conversation they are part of, in the same shapes as everything else
    /// in it.
    ///
    /// **These rows are transient and must stay that way.** Nothing here writes
    /// to the store; ``hangUp()`` files the finished turns on hang-up
    /// and a second writer would give the reader the conversation twice.
    ///
    /// A line is opened the instant a turn begins and carries no text for a
    /// beat, so blank ones are dropped rather than flickering an empty bubble
    /// ahead of every sentence.
    ///
    /// - Parameter conversationID: The chat these turns will eventually be filed
    ///   into. Empty from the home screen, where the call has no conversation
    ///   yet and the save route makes one. Nothing on screen reads it — the row
    ///   needs the field, not the value.
    func liveMessages(conversationID: String = "") -> [NativeChatMessage] {
        controller.transcript.compactMap { line in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return NativeChatMessage(
                id: "voice-\(line.id.uuidString)",
                conversationID: conversationID,
                clientID: nil,
                role: line.role == .assistant ? .assistant : .user,
                content: text,
                reasoning: nil,
                model: nil,
                // One date for the whole call rather than `Date()` per read.
                // This is rebuilt several times a second while someone is
                // talking, and a field that changes on every rebuild makes every
                // row differ from itself.
                createdAt: startedAt,
                revision: 0,
                // The web's `streaming: !line.final`. A non-final line is a live
                // hypothesis being rewritten, not something that was said.
                isPending: !line.final
            )
        }
    }
}

extension EnvironmentValues {
    /// The call in progress, if there is one. Nil is the normal state and means
    /// "this is an ordinary chat" — every voice-mode degradation in the composer
    /// keys off exactly this.
    @Entry var junoVoiceSession: JunoMobileVoiceSession?
}

// MARK: - The call, in the composer

/// What a call is doing, in the web's words (`src/lib/voice-phase.ts`).
///
/// The controller already knows most of this; what it does not publish is the
/// gap after you stop and before Juno starts, which is the one the glow's
/// travelling beam is for. That is read here from the transcript: your last
/// line is final and nothing has come back yet.
enum JunoMobileVoiceCallPhase: Equatable {
    case connecting
    case reconnecting
    case listening
    case thinking
    case speaking
    case interrupting
    case muted
    case ended
    case unavailable

    /// The phase in words. Nothing on screen prints it (the glow says it in
    /// colour and motion); it is the composer's accessibility value.
    var title: String {
        switch self {
        case .connecting: String(localized: "Connecting")
        case .reconnecting: String(localized: "Reconnecting")
        case .listening: String(localized: "Listening")
        case .thinking: String(localized: "Thinking")
        case .speaking: String(localized: "Alevr is speaking")
        case .interrupting: String(localized: "Stopping")
        case .muted: String(localized: "Muted")
        case .ended: String(localized: "Call ended")
        case .unavailable: String(localized: "Connection problem")
        }
    }

    /// Who holds the floor, as the voice light draws it: ember for you,
    /// presence ink for Alevr, the handoff beam while it thinks, graphite
    /// when muted, and no light at all while there is no call to follow.
    var glowMode: JunoVoiceGlowMode {
        switch self {
        case .listening: .you
        case .speaking, .interrupting: .alevr
        case .thinking: .thinking
        case .muted: .muted
        case .connecting, .reconnecting, .ended, .unavailable: .off
        }
    }

    /// Said once on each change, because this is the one mode designed to be
    /// used without looking at the screen.
    var announcement: String {
        switch self {
        case .connecting: String(localized: "Connecting the call.")
        case .reconnecting: String(localized: "Reconnecting the call.")
        case .listening: String(localized: "Listening.")
        case .thinking: String(localized: "Thinking about your answer.")
        case .speaking: String(localized: "Alevr is speaking. Talk any time to interrupt.")
        case .interrupting: String(localized: "Stopping Alevr.")
        case .muted: String(localized: "Your microphone is muted.")
        case .ended: String(localized: "The call has ended.")
        case .unavailable: String(localized: "There is a problem with the call.")
        }
    }
}

extension JunoMobileVoiceSession {
    var callPhase: JunoMobileVoiceCallPhase {
        switch controller.phase {
        case .idle, .connecting: return .connecting
        case .reconnecting: return .reconnecting
        case .ended: return .ended
        case .error: return .unavailable
        case .live:
            if controller.sessionPhase == .interrupting { return .interrupting }
            if controller.assistantSpeaking || controller.playbackAudible { return .speaking }
            if controller.muted { return .muted }
            return awaitingReply ? .thinking : .listening
        }
    }

    /// A turn has been heard in full and nothing has come back yet.
    private var awaitingReply: Bool {
        guard let last = controller.transcript.last else { return false }
        return last.role == .user && last.final
            && !last.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Restart is offered from a finished or failed call, except after a
    /// refusal, where the notice offers Settings instead.
    var isRestartable: Bool {
        switch controller.phase {
        case .ended: true
        case .error(let error): !error.isPermissionDenial
        default: false
        }
    }

    /// Whether this call's provider accepts pictures at all.
    var canSee: Bool { controller.capabilities?.videoInput == true }

    /// Why the call is not running, or why the last one could not be filed. A
    /// failed save wins: it is the only one of the two with something to lose.
    var failureMessage: String? {
        if let saveError { return saveError }
        switch controller.phase {
        case .error(let error): return error.errorDescription
        case .ended(let reason):
            return switch reason {
            case .sessionLimit: String(localized: "voice.ended.limit")
            case .provider: String(localized: "voice.ended.provider")
            case .error: String(localized: "voice.ended.error")
            case .client: nil
            }
        default: return nil
        }
    }

    func toggleCamera() {
        if camera.isLive {
            camera.stop()
        } else {
            screenShare.stop()
            Task { await camera.start(sending: controller) }
        }
    }

    func toggleScreenShare() {
        if screenShare.isLive {
            screenShare.stop()
        } else {
            camera.stop()
            Task { await screenShare.start(sending: controller) }
        }
    }
}

/// The call's news, as one plain line above the composer: colour and a glyph
/// where it needs acting on, muted where it does not. No capsule and no pill,
/// as the web's `VoiceCallNotices` has it. The line carries its fix beside it
/// when there is one: Settings for a refused microphone, Retry and Discard for
/// a conversation that could not be filed (the relay keeps nothing, so a
/// dropped save is a conversation that exists nowhere else).
struct JunoMobileVoiceCallNotices: View {
    let session: JunoMobileVoiceSession

    @Environment(\.openURL) private var openURL

    private var controller: JunoRealtimeVoiceController { session.controller }

    var body: some View {
        VStack(spacing: JunoSpace.tight) {
            if let message = session.failureMessage {
                line(message, icon: .error, tint: Color.junoCaution, role: "juno.mobile.voice-failure")
                if session.saveError != nil {
                    HStack(spacing: JunoSpace.cozy) {
                        Button("voice.save.retry") { session.hangUp() }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.junoAccentInk)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(.rect)
                        Button("voice.save.discard") { session.close() }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.junoMutedForeground)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(.rect)
                    }
                    .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                    .accessibilityIdentifier("juno.mobile.voice-save-error")
                } else if case .error(let error) = controller.phase, error.isPermissionDenial {
                    // A denied microphone is fixed in Settings and never by
                    // trying again: the system will not ask a second time.
                    Button("voice.open-settings") {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        openURL(url)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccentInk)
                    .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
                }
            } else if let notice = controller.notice {
                line(notice, icon: .about, tint: Color.junoMutedForeground, role: "juno.mobile.voice-notice")
            }
            if let message = session.camera.unavailability?.message {
                line(message, icon: .photos, tint: Color.junoCaution, role: "juno.mobile.voice-camera-unavailable")
                if session.camera.unavailability?.isRecoverableInSettings == true {
                    Button("attachments.camera.open-settings") {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        openURL(url)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.junoAccentInk)
                    .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
                }
            }
            if let message = session.screenShare.message {
                line(message, icon: .artifactsTool, tint: Color.junoCaution, role: "juno.mobile.voice-screen-share-unavailable")
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func line(_ text: String, icon: JunoIcon, tint: Color, role: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            JunoIconView(icon, size: 13)
            Text(verbatim: text)
                .multilineTextAlignment(.center)
        }
        .junoFont(size: 13, relativeTo: .footnote)
        .foregroundStyle(tint)
        .padding(.horizontal, JunoSpace.cozy)
        .transition(.opacity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(role)
    }
}

/// The right of the composer's bottom row during a call: the verbs of a call as
/// round icon controls. The web's `VoiceCallControls`.
///
/// There is no status text and no meter beside these any more: the glow is
/// the status, by colour and by motion, and the phase is said in words to
/// VoiceOver (an announcement on every change, and the composer's value).
///
/// Stop exists exactly while Juno speaks. Mute is the one pressed control, and
/// pressed is an ink fill rather than a tint, so it reads at a glance. Call
/// settings gathers everything you set rather than press: the provider, where
/// the sound comes out, push to talk, the camera and the screen, and the
/// full-screen view (captions, the camera preview at size). End is not here:
/// it takes the composer's primary slot, the place Send lives.
struct JunoMobileVoiceCallControls: View {
    let session: JunoMobileVoiceSession

    @AppStorage(JunoMobilePreferences.voicePushToTalk) private var pushToTalk = false
    @State private var muteHaptic = JunoMobileHapticTrigger()
    @State private var stopHaptic = JunoMobileHapticTrigger()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var controller: JunoRealtimeVoiceController { session.controller }

    var body: some View {
        HStack(spacing: 0) {
            if session.isRestartable {
                round(icon: .refresh, label: "Try the call again", identifier: "juno.mobile.voice-restart") {
                    session.saveError = nil
                    Task { await controller.start() }
                }
            } else {
                if controller.assistantSpeaking && session.isLive {
                    round(icon: .stop, size: 12, label: "Stop Alevr speaking", identifier: "juno.mobile.voice-stop") {
                        stopHaptic.fire()
                        controller.interrupt()
                    }
                    .transition(.opacity)
                }
                round(
                    icon: controller.muted ? .micOff : .mic,
                    size: 18,
                    label: controller.muted ? "voice.unmute" : "voice.mute",
                    identifier: "juno.mobile.voice-mute",
                    pressed: controller.muted
                ) {
                    muteHaptic.fire()
                    controller.setMuted(!controller.muted)
                }
                .disabled(!session.isLive)
                // The website's third verb: share the screen, offered while
                // the call is live and the provider can see.
                if session.canSee && session.isLive {
                    round(
                        icon: .monitorUp,
                        label: session.screenShare.isLive ? "Stop sharing your screen" : "Share your screen",
                        identifier: "juno.mobile.voice-screen-share",
                        pressed: session.screenShare.isLive
                    ) {
                        session.toggleScreenShare()
                    }
                    .disabled(session.screenShare.isBusy)
                    .transition(.opacity)
                }
            }
            settingsMenu
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: controller.assistantSpeaking)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: controller.muted)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: session.screenShare.isLive)
        .junoHaptic(JunoMobileHaptic.mute, trigger: muteHaptic)
        .junoHaptic(JunoMobileHaptic.stop, trigger: stopHaptic)
        .modifier(JunoMobileVoiceCallLifecycle(session: session))
    }

    /// Everything you set, as opposed to everything you press.
    private var settingsMenu: some View {
        Menu {
            Section("voice.provider") {
                ForEach(JunoVoiceProvider.allCases) { provider in
                    Button {
                        controller.switchProvider(provider)
                    } label: {
                        if provider == controller.provider {
                            JunoIconLabel(verbatim: provider.modelName, icon: .check)
                        } else {
                            Text(provider.modelName)
                        }
                    }
                    .disabled(provider == controller.provider)
                }
            }
            if controller.provider.offersReasoningEffort {
                // The provider's thinking dial (a slider cannot live in a menu; Settings › Voice has the track).
                Picker("voice.thinking", selection: Binding(
                    get: { controller.reasoningEffort },
                    set: { controller.setReasoningEffort($0) }
                )) {
                    ForEach(controller.provider.reasoningEfforts) { effort in
                        Text(effort.displayName).tag(effort)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("juno.mobile.voice-effort")
            }
            Section {
                Button {
                    controller.toggleSpeaker()
                } label: {
                    JunoIconLabel(
                        controller.speakerOutput ? "voice.speaker.on" : "voice.speaker.off",
                        icon: .volume
                    )
                }
                Toggle(isOn: $pushToTalk) {
                    Label("Push to talk", image: JunoIcon.hand.assetName(.regular))
                }
            }
            Section {
                if session.canSee {
                    Button {
                        session.toggleCamera()
                    } label: {
                        JunoIconLabel(
                            session.camera.isLive ? "voice.camera.stop" : "voice.camera.start",
                            icon: .camera
                        )
                    }
                    .disabled(!session.isLive || session.camera.isBusy)
                } else {
                    // Not a disabled switch: the reason is the useful part,
                    // and the fix (another provider) is the section above.
                    JunoIconLabel("voice.camera.unsupported", icon: .camera)
                }
            }
        } label: {
            glyph(.sliders, size: 16, pressed: false)
        }
        .menuOrder(.fixed)
        .tint(Color.primary)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .accessibilityLabel("Call settings")
        .accessibilityIdentifier("juno.mobile.voice-settings")
    }

    private func round(
        icon: JunoIcon,
        size: CGFloat = 16,
        label: LocalizedStringKey,
        identifier: String,
        pressed: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            glyph(icon, size: size, pressed: pressed)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(pressed ? .isSelected : [])
        .accessibilityIdentifier(identifier)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
    }

    /// The website's `CallButton`: a bare glyph in muted ink on the card's
    /// own glass, in a 44pt target. Pressed (muted, sharing) is a 36pt ink
    /// disc with the glyph in the canvas colour, so the one state worth
    /// noticing is the one that changes shape.
    private func glyph(_ icon: JunoIcon, size: CGFloat, pressed: Bool) -> some View {
        JunoIconView(icon, size: size)
            .foregroundStyle(pressed ? Color.junoCanvas : Color.junoMutedForeground)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Color.junoForeground).opacity(pressed ? 1 : 0))
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }
}

/// End, in the composer's primary slot (Send's place) while nothing is typed:
/// a solid destructive disc, the one coloured control in a call. The glyph
/// takes the canvas ink, white on the light red and near-black on the dark
/// appearance's lifted red, as the web's `destructive-foreground` does.
struct JunoMobileVoiceCallEnd: View {
  let session: JunoMobileVoiceSession
  /// Runs first, for the host's haptic.
  var onEnd: () -> Void = {}

  var body: some View {
    Button {
      onEnd()
      session.hangUp()
    } label: {
      Group {
        if session.isSaving {
          ProgressView().tint(Color.junoCanvas)
        } else {
          JunoIconView(.phoneOff, size: 19)
        }
      }
      .foregroundStyle(Color.junoCanvas)
      .frame(width: 36, height: 36)
      .background(Circle().fill(Color.junoDanger))
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(session.isSaving)
    .accessibilityLabel("voice.end")
    .accessibilityIdentifier("juno.mobile.voice-end")
  }
}

/// The voice light on the composer while it is a call: the website's light,
/// on the card's own edge. Ember while you speak, presence while Alevr does,
/// the handoff beam while it thinks — each voice from its own audio, so
/// talking over Alevr lights both. Nothing is drawn over the field.
///
/// A leaf, so the levels it samples every frame reach only the canvas.
struct JunoMobileVoiceComposerGlow: View {
    let session: JunoMobileVoiceSession
    var cornerRadius: CGFloat = 24

    var body: some View {
        let controller = session.controller
        JunoVoiceGlow(
            mode: session.callPhase.glowMode,
            you: { [controller] in controller.micLoudness },
            alevr: { [controller] in controller.replyLoudness },
            cornerRadius: cornerRadius
        )
    }
}

/// What a call needs from whatever surface is showing it: the camera stopped
/// when the audio stops, the Live Activity kept in step, the haptics on
/// connect and as Juno starts speaking, and the phase announced. Applied by the composer, which is the call now.
struct JunoMobileVoiceCallLifecycle: ViewModifier {
    let session: JunoMobileVoiceSession

    func body(content: Content) -> some View {
        content
            // A camera outlives nothing: frames with nowhere to go would be
            // the app filming for no one.
            .onChange(of: session.isLive) { _, live in
                if !live {
                    session.camera.stop()
                    session.screenShare.stop()
                }
            }
            // The call survives the composer (navigating away must not hang
            // up); only the camera stops with it.
            .onDisappear {
                session.camera.stop()
                session.screenShare.stop()
            }
            .sensoryFeedback(JunoMobileHaptic.connect, trigger: session.isLive) { _, live in live }
            // The glow is the status now, so every change is also said.
            .onChange(of: session.callPhase) { _, phase in
                AccessibilityNotification.Announcement(phase.announcement).post()
            }
            // A light tap as Juno takes the floor: the one change worth
            // feeling with the phone in a pocket.
            .sensoryFeedback(.impact(weight: .light, intensity: 0.5), trigger: session.callPhase) { _, phase in
                phase == .speaking
            }
            .onChange(of: session.controller.phase) { _, phase in
                JunoMobileLiveActivityCoordinator.shared.updateVoice(
                    phase: phase.liveActivityStatus, muted: session.controller.muted
                )
            }
            .onChange(of: session.controller.muted) { _, muted in
                JunoMobileLiveActivityCoordinator.shared.updateVoice(
                    phase: session.controller.phase.liveActivityStatus, muted: muted
                )
            }
    }
}

/// One voice call's worth of transcript, ready to be filed.
///
/// The session id travels with it because the save is idempotent per session:
/// a retry after a dropped network has to be recognised as the *same* save, or
/// the reader ends up with the conversation twice.
struct JunoMobileVoiceTranscript {
    let sessionID: UUID
    let turns: [NativeVoiceTranscriptClient.Turn]
}

/// The call's one-word state outside the app. The Live Activity updates on
/// phase and mute only — not on speaking flips, which change several times a
/// minute and would spend ActivityKit's update budget on nothing.
extension JunoRealtimeVoiceController.Phase {
    var liveActivityStatus: String {
        switch self {
        case .idle, .connecting: "Connecting…"
        case .live: "Live"
        case .reconnecting: "Reconnecting…"
        case .error: "Unavailable"
        case .ended: "Ended"
        }
    }
}

import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoVoiceKit
import SwiftUI

/// One spoken conversation, owned by the screen that started it.
///
/// `id` doubles as the save's idempotency key. It used to be `@State` on the
/// voice view, which was safe only while that view was a sheet — a sheet is
/// created once and lives exactly as long as its session. The dock that replaced
/// it lives inside the chat column and can be rebuilt underneath a call (a
/// draft becoming a conversation is enough), and a fresh `sessionID` there would
/// file a retried save as a second conversation. Held here, it cannot move.
struct DesktopVoiceSession: Identifiable {
    let id = UUID()
    /// When the call was dialled.
    ///
    /// The only honest stamp there is for a spoken line: `TranscriptLine`
    /// carries none, because a hypothesis rewritten five times a second has no
    /// single moment it happened at. The live view needs *a* date to build a
    /// message row from, and one that changes on every frame would make every
    /// row look new to SwiftUI on every partial transcript.
    let startedAt = Date()
    let controller: JunoRealtimeVoiceController
    let modelID: String
    let conversationID: String?
    let projectID: String?
}

enum DesktopVoiceError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        "Voice transcript saving is unavailable for this account."
    }
}

/// Account-owned authorization adapter for the shared realtime audio engine.
///
/// The app supplies the bearer-authenticated request sender; JunoVoiceKit never
/// reaches into Keychain or creates a second backend client.
///
/// **The open conversation rides along.** A call started from a chat names its
/// thread, so the server can give the call that thread's voice — an agent's
/// name and manner in the agent's own thread. The server decides what, if
/// anything, the id changes; Code and a project's overview send none, and their
/// calls are Juno's.
struct JunoDesktopVoiceAuthorization: JunoVoiceRelayAuthorizing {
    let sender: any NativeAuthenticatedRequestSending
    let accountID: AccountID
    var conversationID: String? = nil

    func relayToken() async throws -> JunoVoiceRelayToken {
        var query: [URLQueryItem] = []
        if let conversationID, !conversationID.isEmpty {
            query.append(URLQueryItem(name: "conversationId", value: conversationID))
        }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/voice/relay-token",
                queryItems: query,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw JunoDesktopVoiceAuthorizationError(
                message: serverMessage(response.body)
                    ?? fallbackMessage(statusCode: response.statusCode)
            )
        }
        guard let decoded = try? JSONDecoder().decode(
            JunoVoiceRelayTokenResponse.self,
            from: response.body
        ), !decoded.token.isEmpty else {
            throw JunoDesktopVoiceAuthorizationError(
                message: "Alevr returned an invalid voice credential."
            )
        }
        return decoded.resolved
    }

    private func serverMessage(_ body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return nil }
        if let message = object["message"] as? String, !message.isEmpty {
            return message
        }
        if let error = object["error"] as? String,
            !error.isEmpty, !error.contains("_")
        {
            return error
        }
        return nil
    }

    private func fallbackMessage(statusCode: Int) -> String {
        switch statusCode {
        case 401: "Sign in again to start voice."
        case 402, 403: "Voice is not available on this account or plan."
        case 429: "Voice is busy. Wait a moment and try again."
        case 503: "Realtime voice is not configured for this environment."
        default: "Alevr could not authorize the voice session."
        }
    }
}

private struct JunoDesktopVoiceAuthorizationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Everything a chat column needs to host a call in place: the session itself,
/// and the two things only the screen above knows — where a finished transcript
/// is filed, and what "close" means afterwards.
///
/// The two sites route a saved call differently on purpose. Chat passes the open
/// `conversationID` and selects the conversation the turns landed in; Projects
/// always passes `nil` and opens whatever the server created. They are not
/// unified here because they are not the same behaviour.
struct DesktopVoiceColumn {
    let sessionID: UUID
    let controller: JunoRealtimeVoiceController
    let saveTranscript:
        (UUID, [NativeVoiceTranscriptClient.Turn]) async throws -> String
    let close: () -> Void
}

extension EnvironmentValues {
    /// The call the composer under this view is inside, if there is one.
    ///
    /// Published rather than passed as a parameter because the two surfaces that
    /// host a composer reach a call differently — Chat owns the session, the
    /// project overview builds its own — and both announce it with
    /// ``SwiftUI/View/junoVoiceCall(_:)``. The composer reads it to route a typed
    /// turn over the socket and to turn its controls row into the call bar, and
    /// it mirrors `junoVoiceSession` on the phone.
    @Entry var junoVoiceCall: DesktopVoiceColumn?
}

extension View {
    /// Tells the composer under this view that it is inside `column`'s call.
    ///
    /// That is all Chat and the project overview need: the call is drawn
    /// **inside** the composer's shell (§5.8, Voice call). Its bottom row
    /// becomes ``DesktopVoiceCallBar`` and its bottom edge carries the voice
    /// glow, so there is no dock above it and no field behind it.
    func junoVoiceCall(_ column: DesktopVoiceColumn?) -> some View {
        environment(\.junoVoiceCall, column)
    }

    /// The call for a surface whose composer is not Chat's: Juno Code's
    /// landing and session. The same parts as Chat's call row
    /// (``DesktopVoiceCallControls``, ``DesktopVoiceCallEnd`` and the glow as
    /// the status) in one quiet bar directly above the content, the web's
    /// `RealtimeVoice`. No field behind it.
    func junoVoiceColumn(_ column: DesktopVoiceColumn?) -> some View {
        modifier(DesktopVoiceDockLayer(column: column))
    }
}

/// The bar, directly above the composer, announcing the call to the composer
/// beneath it from the same modifier, so a surface can never end up with the
/// controls of a call the composer knows nothing about.
private struct DesktopVoiceDockLayer: ViewModifier {
    let column: DesktopVoiceColumn?

    func body(content: Content) -> some View {
        VStack(spacing: 0) {
            if let column {
                DesktopVoiceDock(column: column)
                    .padding(.horizontal, JunoSpace.roomy)
                    .padding(.bottom, JunoSpace.snug)
                    .transition(.opacity)
            }
            content
        }
        .environment(\.junoVoiceCall, column)
    }
}

// MARK: - What a call says about itself

/// Where a call is, in the words a person uses for it: the web's `VoicePhase`
/// (`src/lib/voice-phase.ts`), derived from the controller.
///
/// `thinking` is the one the controller does not name: the caller has finished
/// a sentence and no answer has started. The native controller has no
/// `awaitingResponse`, so it is read from the transcript: the newest line is
/// the caller's, and it is final.
enum DesktopVoiceCallPhase: Equatable {
    case connecting
    case reconnecting
    case listening
    case thinking
    case speaking
    case interrupting
    case muted
    case ended
    case failed

    /// Holds the glow still: there is no live audio to follow.
    var pausesGlow: Bool {
        switch self {
        case .connecting, .reconnecting, .ended, .failed: true
        default: false
        }
    }

    /// Who holds the floor, as the voice light draws it: ember for you,
    /// presence ink for Alevr, the handoff beam while it thinks, graphite
    /// when muted, no light while there is no call to follow.
    var glowMode: JunoVoiceGlowMode {
        switch self {
        case .listening, .interrupting: .you
        case .speaking: .alevr
        case .thinking: .thinking
        case .muted: .muted
        case .connecting, .reconnecting, .ended, .failed: .off
        }
    }

    /// Muted is still and low, like a call with no live audio.
    var holdsGlowStill: Bool { pausesGlow || self == .muted }
}

/// The words a call uses to describe itself, and the rules behind them: one
/// copy, read by Chat's call row and Code's bar alike, so the two products
/// describe the same call in the same words.
@MainActor
enum DesktopVoiceCallText {
    static func phase(_ controller: JunoRealtimeVoiceController) -> DesktopVoiceCallPhase {
        switch controller.phase {
        case .idle, .connecting: return .connecting
        case .reconnecting: return .reconnecting
        case .error: return .failed
        case .ended: return .ended
        case .live:
            if controller.sessionPhase == .interrupting { return .interrupting }
            if controller.assistantSpeaking || controller.playbackAudible { return .speaking }
            if controller.muted { return .muted }
            if controller.sessionPhase == .responding { return .thinking }
            if let last = controller.transcript.last, last.role == .user, last.final,
                !last.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                return .thinking
            }
            return .listening
        }
    }

    /// The label, the web's `PHASE_LABEL`. `wide` names who is talking
    /// ("Juno is speaking"); a narrow composer keeps the verb, so the controls
    /// never lose their place in the row.
    static func label(_ phase: DesktopVoiceCallPhase, wide: Bool = true) -> String {
        switch phase {
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .listening: "Listening"
        case .thinking: "Thinking"
        case .speaking: wide ? "Alevr is speaking" : "Speaking"
        case .interrupting: "Interrupting"
        case .muted: "Muted"
        case .ended: "Call ended"
        case .failed: "Voice unavailable"
        }
    }

    /// What VoiceOver hears when the phase changes: the web's
    /// `PHASE_ANNOUNCEMENT`, with its rule that the caller's own speech is
    /// not announced over itself.
    static func announcement(_ phase: DesktopVoiceCallPhase, previous: DesktopVoiceCallPhase?) -> String? {
        guard phase != previous else { return nil }
        return switch phase {
        case .connecting: "Connecting the call."
        case .reconnecting: "Reconnecting the call."
        case .listening: previous == nil || previous == .connecting ? "Connected. Listening." : "Listening."
        case .thinking: "Thinking about your answer."
        case .speaking: "Alevr is speaking. Talk any time to interrupt."
        case .interrupting: nil
        case .muted: "Your microphone is muted."
        case .ended: "The call has ended."
        case .failed: "There is a problem with the call."
        }
    }

    /// The status's tooltip: the detail that would crowd the row. The provider
    /// carrying the call, how interrupting works on this audio route, and the
    /// running cost at list prices.
    static func statusHelp(_ controller: JunoRealtimeVoiceController) -> String {
        let title = label(phase(controller))
        guard controller.phase == .live else { return title }
        var parts = [controller.provider.displayName, controller.provider.modelName(at: controller.reasoningEffort)]
        if let delegate = controller.provider.delegateModelName {
            let level = controller.provider.delegateEffort(at: controller.reasoningEffort)
            parts.append("thinking with \(delegate) at \(level.displayName.lowercased())")
        }
        switch controller.bargeIn {
        case .automatic: parts.append("talk over Alevr to interrupt")
        case .manualOnly: parts.append("press Stop to interrupt")
        }
        if let cost = costLabel(controller) { parts.append("\(cost) so far") }
        return parts.joined(separator: ", ")
    }

    /// Relay list prices, not billing: hence the tilde.
    static func costLabel(_ controller: JunoRealtimeVoiceController) -> String? {
        guard let usage = controller.usage, usage.estCostUsd > 0 else { return nil }
        return "~" + usd(usage.estCostUsd)
    }

    /// `formatUsd` from `src/lib/utils.ts`, digit for digit.
    static func usd(_ amount: Double) -> String {
        guard amount.isFinite, amount > 0 else { return "$0" }
        if amount < 0.0001 { return "<$0.0001" }
        if amount < 0.01 { return String(format: "$%.4f", amount) }
        if amount < 1 { return String(format: "$%.3f", amount) }
        return String(format: "$%.2f", amount)
    }

    /// Why the call is not running, or why the last one could not be filed. A
    /// failed save wins: it is the only one of the two that still has something
    /// to lose.
    static func failureMessage(_ controller: JunoRealtimeVoiceController, saveError: String?) -> String? {
        if let saveError { return saveError }
        switch controller.phase {
        case .error(let error): return error.errorDescription
        case .ended(let reason):
            return switch reason {
            case .sessionLimit: "This voice session reached its time limit."
            case .provider: "The voice provider ended this session."
            case .error: "The voice relay ended this session after an error."
            case .client: nil
            }
        default: return nil
        }
    }

    /// Restart is offered from a finished or failed session, except after a
    /// refusal, where the failure line offers Settings instead.
    static func isRestartable(_ controller: JunoRealtimeVoiceController) -> Bool {
        switch controller.phase {
        case .ended: true
        case .error(let error): !error.isPermissionDenial
        default: false
        }
    }

    /// Only Gemini and Qwen accept a screen. Gated on what the relay said in
    /// `session.ready`, rather than on a list kept here to drift.
    static func canShareScreen(_ controller: JunoRealtimeVoiceController) -> Bool {
        controller.phase == .live
            && (controller.capabilities?.screenInput == true || controller.capabilities?.videoInput == true)
    }

    /// One line per provider, describing the trade it makes: the web's
    /// `PROVIDER_BLURB`, kept to what the relay's registry says each can do.
    static func providerBlurb(_ provider: JunoVoiceProvider) -> String {
        switch provider {
        case .openai: "Full duplex, thinks with GPT-6.1 Sol"
        case .gemini: "Screen sharing, thinks with Gemini 3.8 Flash"
        case .qwen: "Long calls, sees images and your screen"
        case .minimax: "Speech pipeline, no vision, no screen"
        }
    }

    /// The finished lines, in order. Non-final lines are hypotheses the
    /// recognizer is still rewriting, and saving one puts a half-heard sentence
    /// into the reader's permanent history.
    static func savableTurns(_ controller: JunoRealtimeVoiceController) -> [NativeVoiceTranscriptClient.Turn] {
        controller.transcript.compactMap { line in
            let content = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.final, !content.isEmpty else { return nil }
            return NativeVoiceTranscriptClient.Turn(
                role: line.role == .assistant ? .assistant : .user,
                content: content
            )
        }
    }

    /// The Privacy pane a refused permission is fixed in. The system will not
    /// re-prompt, so this, not a retry, is the way forward.
    static func openPrivacySettings(for error: JunoRealtimeVoiceError) {
        let pane = error == .micPermissionDenied ? "Privacy_Microphone" : "Privacy_SpeechRecognition"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }
}

/// Hanging up, and what happens to the conversation afterwards.
///
/// A reference type because the call bar and the line above the shell that
/// reports a failed save are two views of one state. Held by whoever hosts the
/// call's controls — the composer in Chat and the project overview, the dock
/// in Code — for as long as that host lives.
@MainActor
@Observable
final class DesktopVoiceHangUp {
    private(set) var isSaving = false
    /// A save that failed is a conversation that exists nowhere — the relay
    /// keeps nothing — so this stays on screen until it succeeds or the reader
    /// hangs up again.
    private(set) var saveError: String?

    /// Hang up, then file the conversation.
    ///
    /// **In that order, and the order is the point.** `end()` first, so the
    /// microphone and the socket are down the instant the reader asks — waiting
    /// on a network round trip with a live mic is the one thing a hang-up must
    /// never do. The save then runs against the transcript the controller
    /// already holds, and the controls stay up with a spinner while it does,
    /// because closing first would leave a failed save with nowhere to report.
    func hangUp(_ column: DesktopVoiceColumn) {
        column.controller.end()
        let turns = DesktopVoiceCallText.savableTurns(column.controller)
        guard !turns.isEmpty else {
            column.close()
            return
        }
        isSaving = true
        saveError = nil
        Task {
            do {
                _ = try await column.saveTranscript(column.sessionID, turns)
                isSaving = false
                column.close()
            } catch {
                saveError = error.localizedDescription
                isSaving = false
            }
        }
    }

    func restart(_ column: DesktopVoiceColumn) {
        saveError = nil
        Task { await column.controller.start() }
    }

    /// A new call starts clean: a failed save belongs to the call it was for.
    func reset() {
        isSaving = false
        saveError = nil
    }
}

// MARK: - The call's parts

/// The call, as the composer's bottom row (§5.8, Voice call): the web's
/// `voiceCallParts` in the composer's slots.
///
/// `[+] ······ Stop · Mute · Share · Settings · [End | Send]`. No meter and no
/// phase label: the glow along the shell's bottom edge is the status
/// (``DesktopVoiceComposerGlow``), and the phase is announced in words.
/// The composer's field stays above it, because a call can be typed into (a
/// sentence, a picture) and that turn goes over the socket rather than to the
/// chat route. `+` is the composer's own, handed in. The primary slot ends the
/// call, the same size and place as Send; once something is typed it is Send
/// (`trailing`), exactly as on the web.
///
/// **What this replaced.** A row of mixed controls with the words "Stop
/// Speaking", a meter, a phase label, a cost in mono and a kebab for the
/// provider. Now the right holds round icon controls with their names in
/// tooltips, and the call's detail is in Call settings' tooltip.
///
/// Closing the column ends the call: the alternative is a microphone that is
/// open with nothing on screen saying so. It deliberately does not start one;
/// starting is the screen's job, at the moment the disc is pressed.
struct DesktopVoiceCallBar<Leading: View, Primary: View>: View {
    let column: DesktopVoiceColumn
    let hangUp: DesktopVoiceHangUp
    /// Whether something is typed, which turns the primary slot into Send.
    var hasDraft = false
    @ViewBuilder let leading: () -> Leading
    /// The composer's own Send, shown instead of End while there is a draft.
    @ViewBuilder let primary: () -> Primary

    var body: some View {
        HStack(spacing: JunoComposerMetrics.controlSpacing) {
            leading()
            Spacer(minLength: JunoSpace.snug)
            DesktopVoiceCallControls(column: column, hangUp: hangUp)
            if hasDraft {
                primary()
            } else {
                DesktopVoiceCallEnd(column: column, hangUp: hangUp)
            }
        }
        .onDisappear { column.controller.end() }
        .junoVoiceCallAnnouncements(column.controller)
        .accessibilityIdentifier("juno.desktop.voice")
    }
}

/// Says each phase change out loud: with no label on screen (the glow is the
/// status), VoiceOver is told in words, the web's `PHASE_ANNOUNCEMENT`, and
/// the call's container carries the phase as its value.
private struct DesktopVoiceCallAnnouncer: ViewModifier {
    let controller: JunoRealtimeVoiceController

    @State private var announced: DesktopVoiceCallPhase?

    func body(content: Content) -> some View {
        let phase = DesktopVoiceCallText.phase(controller)
        content
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Voice call")
            .accessibilityValue(DesktopVoiceCallText.label(phase))
            .accessibilityHint(DesktopVoiceCallText.statusHelp(controller))
            .onChange(of: phase, initial: true) { _, next in
                let before = announced
                announced = next
                guard let message = DesktopVoiceCallText.announcement(next, previous: before) else { return }
                AccessibilityNotification.Announcement(message).post()
            }
    }
}

extension View {
    /// The call's phase, for assistive technology only.
    func junoVoiceCallAnnouncements(_ controller: JunoRealtimeVoiceController) -> some View {
        modifier(DesktopVoiceCallAnnouncer(controller: controller))
    }
}

/// The verbs of a call, as round icon controls: the web's `VoiceCallControls`.
///
/// Stop exists exactly while there is speech to stop. Mute and Share are
/// toggles: pressed, they take the ink fill, so their state reads without
/// their names. Settings holds what you set rather than press.
struct DesktopVoiceCallControls: View {
    let column: DesktopVoiceColumn
    let hangUp: DesktopVoiceHangUp

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var controller: JunoRealtimeVoiceController { column.controller }

    var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            if DesktopVoiceCallText.isRestartable(controller) {
                DesktopVoiceCallButton(icon: .refresh, label: "Try the call again") {
                    hangUp.restart(column)
                }
                .accessibilityIdentifier("juno.desktop.voice-restart")
            } else {
                if controller.phase == .live, controller.assistantSpeaking {
                    DesktopVoiceCallButton(icon: .stop, weight: .fill, glyphSize: 12, label: "Stop Alevr speaking") {
                        controller.interrupt()
                    }
                    .transition(.opacity)
                    .accessibilityIdentifier("juno.desktop.voice-interrupt")
                }
                DesktopVoiceCallButton(
                    icon: controller.muted ? .micOff : .mic,
                    label: controller.muted ? "Turn your microphone back on" : "Mute your microphone",
                    isPressed: controller.muted
                ) {
                    controller.toggleMute()
                }
                .disabled(controller.phase != .live)
                .accessibilityIdentifier("juno.desktop.voice-mute")

                if DesktopVoiceCallText.canShareScreen(controller) {
                    DesktopVoiceCallButton(
                        icon: controller.screenSharing ? .monitorOff : .monitorUp,
                        label: controller.screenSharing ? "Stop sharing your screen" : "Share your screen",
                        isPressed: controller.screenSharing
                    ) {
                        if controller.screenSharing {
                            controller.stopScreenShare()
                        } else {
                            controller.startScreenShare()
                        }
                    }
                    .accessibilityIdentifier("juno.desktop.voice-share-screen")
                }
            }
            DesktopVoiceCallSettings(controller: controller)
        }
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
            value: controller.assistantSpeaking
        )
    }
}

/// One control in a call: a round icon button the size of the composer's own
/// controls, its name in the tooltip and the accessible label. Pressed (muted,
/// sharing) takes the ink fill; at rest it is secondary ink with the glass
/// hover the composer's other controls use.
struct DesktopVoiceCallButton: View {
    let icon: JunoIcon
    var weight: JunoIcon.Weight? = nil
    var glyphSize: CGFloat = 16
    let label: String
    /// The tooltip, when it says more than the label.
    var help: String? = nil
    var isPressed = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            JunoIconView(icon, size: glyphSize, weight: weight)
                .foregroundStyle(isPressed ? Color.junoCanvas : Color.junoSecondaryInk)
                .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                .background {
                    if isPressed {
                        Circle().fill(Color.junoForeground)
                    }
                }
                .contentShape(Circle())
        }
        .buttonStyle(DesktopVoiceCallButtonStyle())
        .help(help ?? label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isPressed ? .isSelected : [])
    }
}

/// The round hover and press of a call control: the composer's control style,
/// in a circle.
struct DesktopVoiceCallButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Control(configuration: configuration)
    }

    private struct Control: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .opacity(isEnabled ? 1 : 0.4)
                .background {
                    Circle()
                        .fill(Color.junoGlassHover)
                        .opacity(hovered && isEnabled ? 1 : 0)
                }
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovered)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

/// Everything you set, as opposed to everything you press: the web's call
/// settings popover. Which model carries the call, each with its provider and
/// the trade it makes, and — on a provider with a thinking dial (GPT-Live 1
/// with GPT-6.1 Sol; Gemini 3.8 Live with Gemini 3.8 Flash) — the composer's
/// own Thinking panel.
struct DesktopVoiceCallSettings: View {
    let controller: JunoRealtimeVoiceController

    @State private var isOpen = false

    var body: some View {
        DesktopVoiceCallButton(
            icon: .sliders,
            label: "Call settings",
            help: "Call settings: \(DesktopVoiceCallText.statusHelp(controller))"
        ) {
            isOpen.toggle()
        }
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text("Voice")
                    .junoType(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .padding(.horizontal, JunoSpace.snug)
                    .padding(.bottom, JunoSpace.hairline)
                    .accessibilityAddTraits(.isHeader)
                ForEach(JunoVoiceProvider.allCases) { provider in
                    providerRow(provider)
                }
                if controller.provider.offersReasoningEffort, let delegate = controller.provider.delegateModelName {
                    Divider()
                        .padding(.vertical, JunoSpace.hairline)
                    // The composer's own Thinking panel (JunoThinkingPanel),
                    // at a fixed size: it measures itself, and a self-sizing
                    // popover around it is the 3.0.5 crash.
                    JunoThinkingPanel(
                        ladder: thinkingLadder(delegate: delegate),
                        stopID: Binding(
                            get: { controller.reasoningEffort.rawValue },
                            set: { id in
                                if let effort = id.flatMap(JunoVoiceReasoningEffort.init(rawValue:)) {
                                    controller.setReasoningEffort(effort)
                                }
                            }
                        ),
                        width: 256
                    )
                    .frame(width: 256, height: JunoThinkingMetrics.height(caption: true, modeToggles: false))
                    .padding(.horizontal, JunoSpace.hairline)
                }
            }
            .padding(JunoSpace.snug)
            .frame(width: 280)
        }
        .accessibilityIdentifier("juno.desktop.voice-options")
    }

    private func providerRow(_ provider: JunoVoiceProvider) -> some View {
        let active = provider == controller.provider
        return Button {
            guard !active else { return }
            controller.switchProvider(provider)
        } label: {
            HStack(spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    // The model is the name, as on the web: it is what answers.
                    Text(provider == controller.provider ? provider.modelName(at: controller.reasoningEffort) : provider.modelName)
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                    Text("\(provider.displayName) · \(DesktopVoiceCallText.providerBlurb(provider))")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if active {
                    JunoIconView(.success, size: 14)
                        .foregroundStyle(Color.junoAccentInk)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(minHeight: 28)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(active ? Color.junoSelectedFill : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
        .accessibilityIdentifier("juno.desktop.voice-provider.\(provider.rawValue)")
    }

    /// The provider's dial as the shared control reads it. The caption says
    /// what the current rung runs, since on Gemini a rung picks the Live model
    /// and Gemini 3.8 Flash's level together.
    private func thinkingLadder(delegate: String) -> JunoThinkingLadder {
        let provider = controller.provider
        let effort = controller.reasoningEffort
        return JunoThinkingLadder(
            stops: provider.reasoningEfforts.map {
                JunoThinkingStop(id: $0.rawValue, label: $0.displayName, accessibilityLabel: "Thinking \($0.displayName)")
            },
            modelName: delegate,
            caption: "\(provider.modelName(at: effort)) answers. \(delegate) takes the harder questions at "
                + "\(provider.delegateEffort(at: effort).displayName.lowercased()) and can search the web."
        )
    }
}

/// End, in the composer's primary slot: a round red disc the size and place
/// of Send, so the hand already knows where it is, and the only coloured
/// control in a call. Destructive, not the accent: it is the one control that
/// loses something if pressed by mistake.
struct DesktopVoiceCallEnd: View {
    let column: DesktopVoiceColumn
    let hangUp: DesktopVoiceHangUp

    var body: some View {
        Button {
            hangUp.hangUp(column)
        } label: {
            ZStack {
                Circle().fill(Color.junoDestructive)
                if hangUp.isSaving {
                    ProgressView()
                        .controlSize(.small)
                        .environment(\.colorScheme, .dark)
                } else {
                    JunoIconView(.phoneOff, size: 14)
                        .foregroundStyle(.white)
                }
            }
            .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
            .contentShape(Circle())
        }
        .buttonStyle(ComposerDiscStyle())
        .disabled(hangUp.isSaving)
        .help("End call")
        .accessibilityLabel("End the call")
        .accessibilityIdentifier("juno.desktop.voice-end")
    }
}

/// The voice glow on the composer's bottom edge during a call, and the call's
/// only visible status: the shared ``JunoVoiceGlow``, fed by this call and
/// toned by its phase (``DesktopVoiceCallPhase/glowTone``), clipped to the
/// shell by the host.
///
/// A leaf, so the phase it reads (and the level the glow samples per frame)
/// invalidate this view and nothing else.
struct DesktopVoiceComposerGlow: View {
    let controller: JunoRealtimeVoiceController
    /// The shell's own radius, so the light runs on its edge.
    var cornerRadius: CGFloat = JunoComposerMetrics.cornerRadius

    var body: some View {
        JunoVoiceGlow(
            mode: DesktopVoiceCallText.phase(controller).glowMode,
            you: { [controller] in controller.micLoudness },
            alevr: { [controller] in controller.replyLoudness },
            cornerRadius: cornerRadius
        )
    }
}

/// A call's error or notice, as one plain line above the composer: the web's
/// `VoiceCallNotices`. A warning glyph and the destructive ink where it needs
/// acting on, muted where it does not. No fill, no rim, no capsule.
struct DesktopVoiceCallNotices: View {
    let column: DesktopVoiceColumn
    let hangUp: DesktopVoiceHangUp

    private var controller: JunoRealtimeVoiceController { column.controller }

    var body: some View {
        if let failure = DesktopVoiceCallText.failureMessage(controller, saveError: hangUp.saveError) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                JunoIconView(.warning, size: 12)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                Text(failure)
                    .fixedSize(horizontal: false, vertical: true)
                if case .error(let error) = controller.phase, error.isPermissionDenial {
                    Button {
                        DesktopVoiceCallText.openPrivacySettings(for: error)
                    } label: {
                        Text("Open Privacy Settings")
                            .foregroundStyle(Color.junoAccentInk)
                            .frame(minHeight: 28)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .junoFont(size: 12, relativeTo: .footnote)
            .foregroundStyle(Color.junoDestructiveInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isStaticText)
            .accessibilityIdentifier("juno.desktop.voice-failure")
        } else if let notice = controller.notice {
            Text(verbatim: notice)
                .fixedSize(horizontal: false, vertical: true)
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("juno.desktop.voice-notice")
        }
    }
}

// MARK: - Code: the call bar

/// **The call for Juno Code**: the same parts as Chat's call row, in one quiet
/// bar directly above Code's content (the web's `RealtimeVoice`, for surfaces
/// without a composer of their own to become the call).
///
/// Code's composer is its own (``StudioComposer``), so the call cannot move
/// into it the way Chat's does; the bar says and does exactly what Chat's row
/// does, so the two products cannot describe one call differently. The notice
/// line sits above it, plain text, as in Chat.
///
/// **No field.** The voice field that used to spread behind Code's composer
/// during a call was an aura. The glow is drawn inside the bar's own capsule,
/// as it is inside Chat's shell, and is the bar's status.
struct DesktopVoiceDock: View {
    let column: DesktopVoiceColumn

    @State private var hangUp = DesktopVoiceHangUp()
    /// `motion-safe:animate-rise-in`. Self-driven rather than a `.transition`,
    /// because a transition only plays if whichever screen mounted the bar
    /// wrapped the change in `withAnimation`.
    @State private var risen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: JunoSpace.tight) {
            DesktopVoiceCallNotices(column: column, hangUp: hangUp)
                .frame(maxWidth: 448)
            JunoDesktopGlass(spacing: JunoSpace.hairline) {
                HStack(spacing: JunoComposerMetrics.controlSpacing) {
                    Spacer(minLength: JunoSpace.cozy)
                    DesktopVoiceCallControls(column: column, hangUp: hangUp)
                    DesktopVoiceCallEnd(column: column, hangUp: hangUp)
                }
                .padding(JunoSpace.tight)
                .frame(width: 320)
                .junoGlass(in: Capsule(style: .continuous))
                // The glow is the status here too, inside the bar's shape.
                .overlay {
                    DesktopVoiceComposerGlow(controller: column.controller)
                        .clipShape(Capsule(style: .continuous))
                }
            }
        }
        .frame(maxWidth: JunoReadingMeasure.reading)
        .opacity(risen ? 1 : 0)
        .offset(y: risen || reduceMotion ? 0 : 8)
        .onAppear {
            withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)) {
                risen = true
            }
        }
        // Ends the call when the column goes, and deliberately does not start
        // one: `start()` is legal from `ended`, so a bar that restarted on
        // appearance would silently redial.
        .onDisappear { column.controller.end() }
        .junoVoiceCallAnnouncements(column.controller)
        .accessibilityIdentifier("juno.desktop.voice")
    }
}

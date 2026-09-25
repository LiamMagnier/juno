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
                message: "Juno returned an invalid voice credential."
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
        default: "Juno could not authorize the voice session."
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
    /// **inside** the composer's shell (§5.8, Voice call) — its controls row
    /// becomes ``DesktopVoiceCallBar`` — so there is no dock above it and no
    /// field behind it. The pill and the light that used to frame a call were a
    /// second surface and an aura, and the redesign keeps neither.
    func junoVoiceCall(_ column: DesktopVoiceColumn?) -> some View {
        environment(\.junoVoiceCall, column)
    }

    /// The dock above this composer and the voice field behind the pair.
    ///
    /// **Code's, not Chat's.** Chat drew a dock and a field around its composer
    /// until the Liquid Glass redesign moved the call into the composer (§5.8:
    /// "No aura"). Juno Code's landing and session surfaces still wrap their
    /// composer in both, until the Code rework decides their voice UI; this is
    /// kept working for them, unchanged.
    func junoVoiceColumn(_ column: DesktopVoiceColumn?) -> some View {
        modifier(DesktopVoiceComposerLayer(column: column))
    }
}

/// The dock, directly above the composer, announcing the call to the composer
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

/// Code's composer-scoped arrangement: the dock above, the field behind the pair.
///
/// The field's height is fixed here rather than taken from the host, because the
/// host is a composer — a couple of hundred points tall at most, and 46% of that
/// is not a field, it is a hairline.
private struct DesktopVoiceComposerLayer: ViewModifier {
    let column: DesktopVoiceColumn?

    private static let fieldHeight: CGFloat = 460

    func body(content: Content) -> some View {
        content
            .modifier(DesktopVoiceDockLayer(column: column))
            // Behind the dock *and* the composer, so the light passes under the
            // pill as well as under the composer.
            .background(alignment: .bottom) {
                if let column {
                    DesktopVoiceField(controller: column.controller)
                        .frame(height: Self.fieldHeight)
                        // The band's brightest edge belongs just past the
                        // composer, so the light looks like it is coming from
                        // under it rather than stopping at a seam.
                        .offset(y: JunoSpace.roomy)
                }
            }
    }
}

/// The field, in a view of its own.
///
/// It is a leaf so that `level` — which the controller republishes about thirty
/// times a second — invalidates one `Canvas` and nothing else.
private struct DesktopVoiceField: View {
    let controller: JunoRealtimeVoiceController

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lit = false

    var body: some View {
        JunoVoiceAura(
            level: controller.level,
            speaking: controller.assistantSpeaking,
            active: controller.phase == .live || controller.phase == .reconnecting
        )
        .opacity(lit ? 1 : 0)
        .onAppear {
            // Ambient tier: under Reduce Motion the field is at full strength
            // on the first frame, because a live microphone has to stay visible.
            withAnimation(JunoMotion.ambient(JunoMotion.outSoft(), when: reduceMotion)) {
                lit = true
            }
        }
    }
}

// MARK: - What a call says about itself

/// The words a call uses to describe itself, and the rules behind them — one
/// copy, read by Chat's call bar and Code's dock alike, so the two products
/// describe the same call in the same words.
@MainActor
enum DesktopVoiceCallText {
    /// The web's ladder, verbatim.
    static func statusTitle(_ controller: JunoRealtimeVoiceController) -> String {
        switch controller.phase {
        case .idle, .connecting: "Connecting"
        case .reconnecting: "Reconnecting…"
        case .error: "Voice unavailable"
        case .ended: "Session ended"
        case .live: liveStatusTitle(controller)
        }
    }

    /// The three states a live call is actually in, which the controller's
    /// phase collapses into one.
    ///
    /// `interrupting` earns its own line: it is the round trip between the
    /// interrupt going out and the relay confirming it dropped the turn, and for
    /// that stretch the speakers are already silent. Left saying "Juno is
    /// speaking" it reads as an interruption that was ignored.
    private static func liveStatusTitle(_ controller: JunoRealtimeVoiceController) -> String {
        if controller.sessionPhase == .interrupting { return "Interrupting…" }
        if controller.assistantSpeaking { return "Juno is speaking" }
        return controller.muted ? "Microphone off" : "Listening"
    }

    /// The tooltip on the status, which is where the barge-in *mode* is stated:
    /// without echo cancellation the microphone hears the speakers, and a
    /// session that acted on that would interrupt itself on its own first
    /// syllable.
    static func statusHelp(_ controller: JunoRealtimeVoiceController) -> String {
        let title = statusTitle(controller)
        guard controller.phase == .live else { return title }
        return switch controller.bargeIn {
        case .automatic: "\(title) — talk over Juno to interrupt it"
        case .manualOnly: "\(title) — talk-over interruption needs an echo-cancelled audio route"
        }
    }

    /// Relay list prices, not billing — hence the tilde.
    static func costLabel(_ controller: JunoRealtimeVoiceController) -> String? {
        guard let usage = controller.usage, usage.estCostUsd > 0 else { return nil }
        return "~" + usd(usage.estCostUsd)
    }

    static func costDetail(_ controller: JunoRealtimeVoiceController) -> String {
        guard let usage = controller.usage,
            let input = usage.estCostInUsd,
            let output = usage.estCostOutUsd
        else { return "Estimated session cost" }
        return "Estimated session cost · you ~\(usd(input)) · Juno ~\(usd(output))"
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

    /// Restart is offered from a finished or failed session — except after a
    /// refusal, where the failure line offers Settings instead.
    static func isRestartable(_ controller: JunoRealtimeVoiceController) -> Bool {
        switch controller.phase {
        case .ended: true
        case .error(let error): !error.isPermissionDenial
        default: false
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
    /// re-prompt, so this — not a retry — is the way forward.
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

// MARK: - Chat: the call inside the composer

/// The call, as the composer's controls row (§5.8, Voice call).
///
/// `[+] · meter · status · Stop Speaking · mute · share screen · options ·
/// [send] · hang up`. The composer's field stays above it, because a call can
/// be typed into — a sentence, a picture — and that turn goes over the socket
/// rather than to the chat route. The `+` and the send disc are the
/// composer's own, handed in, so the row's two ends are exactly where they are
/// when no call is running.
///
/// **What this replaced.** A glass pill floating above the composer, lifted by
/// two warm shadows, over a light spread behind the whole column. The pill was
/// a second surface for one control row and the light was an aura; the call is
/// now drawn in the shell that is already there, and says what it is doing in
/// words and a five-bar meter.
///
/// Closing the column ends the call: the alternative is a microphone that is
/// open with nothing on screen saying so. It deliberately does not start one —
/// starting is the screen's job, at the moment the disc is pressed.
struct DesktopVoiceCallBar<Leading: View, Trailing: View>: View {
    let column: DesktopVoiceColumn
    let hangUp: DesktopVoiceHangUp
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing

    private var controller: JunoRealtimeVoiceController { column.controller }

    var body: some View {
        HStack(spacing: JunoComposerMetrics.controlSpacing) {
            leading()

            HStack(spacing: JunoSpace.snug) {
                DesktopVoiceCallMeter(controller: controller)
                Text(DesktopVoiceCallText.statusTitle(controller))
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .lineLimit(1)
                    .help(DesktopVoiceCallText.statusHelp(controller))
                if let cost = DesktopVoiceCallText.costLabel(controller) {
                    // Mono because it is a cost (§10.2 #6), secondary because it
                    // is the quiet half of the status; it reprices every few
                    // seconds, so it is never announced.
                    Text(cost)
                        .junoType(.monoSmall)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                        .help(DesktopVoiceCallText.costDetail(controller))
                        .accessibilityHidden(true)
                }
            }
            .padding(.leading, JunoSpace.tight)
            .fixedSize()
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)

            Spacer(minLength: JunoSpace.snug)

            if controller.phase == .live, controller.assistantSpeaking {
                Button {
                    controller.interrupt()
                } label: {
                    Text("Stop Speaking")
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                        .padding(.horizontal, JunoSpace.snug)
                        .frame(height: JunoComposerMetrics.controlHeight)
                        .contentShape(.rect)
                }
                .buttonStyle(ComposerControlStyle())
                .help("Stop Juno speaking")
                .accessibilityIdentifier("juno.desktop.voice-interrupt")
                .transition(.opacity)
            }

            if DesktopVoiceCallText.isRestartable(controller) {
                callControl(.refresh, label: "Restart voice", isOn: false) {
                    hangUp.restart(column)
                }
                .accessibilityIdentifier("juno.desktop.voice-restart")
            } else {
                callControl(
                    .micOff,
                    label: controller.muted ? "Turn microphone on" : "Turn microphone off",
                    isOn: controller.muted
                ) {
                    controller.toggleMute()
                }
                .disabled(controller.phase != .live)
                .accessibilityIdentifier("juno.desktop.voice-mute")

                if canShareScreen {
                    callControl(
                        .monitorUp,
                        label: controller.screenSharing ? "Stop sharing screen" : "Share screen",
                        isOn: controller.screenSharing
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

            optionsMenu
            trailing()
            hangUpDisc
        }
        .onDisappear { controller.end() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.voice")
    }

    /// Only Gemini and Qwen accept a screen. Gated on what the relay said in
    /// `session.ready`, rather than on a list kept here to drift.
    private var canShareScreen: Bool {
        controller.phase == .live
            && (controller.capabilities?.screenInput == true || controller.capabilities?.videoInput == true)
    }

    /// A 28pt borderless control in the composer's own style. `isOn` is a
    /// switch that is on — muted, sharing — drawn as the resting glass fill,
    /// never the accent (§0.4).
    private func callControl(
        _ icon: JunoIcon,
        label: String,
        isOn: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            JunoIconView(icon, size: 16)
                .foregroundStyle(isOn ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                .background {
                    if isOn {
                        JunoRadius.concentric().fill(Color.junoGlassFill)
                    }
                }
                .contentShape(.rect)
        }
        .buttonStyle(ComposerControlStyle())
        .help(label)
        .accessibilityLabel(label)
        .accessibilityValue(isOn ? "On" : "Off")
    }

    /// Options: which provider carries the call. A native menu with the choice
    /// as a picker, so the system draws the checkmark.
    private var optionsMenu: some View {
        Menu {
            Picker("Provider", selection: providerBinding) {
                ForEach(JunoVoiceProvider.allCases) { provider in
                    Text(provider.displayName).tag(provider)
                }
            }
        } label: {
            JunoIconView(.more, size: 16)
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(ComposerControlStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Voice options")
        .accessibilityLabel("Voice options")
        .accessibilityIdentifier("juno.desktop.voice-options")
    }

    private var providerBinding: Binding<JunoVoiceProvider> {
        Binding(
            get: { controller.provider },
            set: { provider in
                guard provider != controller.provider else { return }
                controller.switchProvider(provider)
            }
        )
    }

    /// The end of the call: a destructive disc the size and place of the
    /// composer's own. Destructive, not coral — this is the one control on the
    /// row that loses something if pressed by mistake, and coral is the
    /// action colour.
    private var hangUpDisc: some View {
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
        .help("End and save")
        .accessibilityLabel("End voice conversation")
        .accessibilityIdentifier("juno.desktop.voice-end")
    }
}

/// The call's level, as the shared five-bar meter.
///
/// A leaf, so the level the controller republishes about thirty times a
/// second invalidates five capsules and not the whole controls row.
private struct DesktopVoiceCallMeter: View {
    let controller: JunoRealtimeVoiceController

    var body: some View {
        ComposerLevelMeter(
            level: controller.level,
            active: controller.phase == .live && !controller.muted
        )
    }
}

/// What the call has to say above the composer: why it is not running, why it
/// could not be filed, or an aside from the relay (§5.1, the caption above the
/// shell).
///
/// Plain caption rows on the canvas — no fill, no rim, no shadow. The strips
/// this replaced were tinted plates with a warm drop shadow, floating over the
/// transcript; a caption beside the shell says the same thing in the place the
/// quota line and the upload errors already use.
struct DesktopVoiceCallNotices: View {
    let column: DesktopVoiceColumn
    let hangUp: DesktopVoiceHangUp

    private var controller: JunoRealtimeVoiceController { column.controller }

    var body: some View {
        if let failure = DesktopVoiceCallText.failureMessage(controller, saveError: hangUp.saveError) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                JunoIconView(.error, size: 12)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                Text(failure)
                    .fixedSize(horizontal: false, vertical: true)
                if case .error(let error) = controller.phase, error.isPermissionDenial {
                    Button {
                        DesktopVoiceCallText.openPrivacySettings(for: error)
                    } label: {
                        Text("Open Privacy Settings")
                            .foregroundStyle(Color.junoAccentInk)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .junoFont(size: 12, relativeTo: .footnote)
            .foregroundStyle(Color.junoDestructiveInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("juno.desktop.voice-failure")
        }
        if let notice = controller.notice {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
                JunoIconView(.warning, size: 12)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                Text(verbatim: notice)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .junoFont(size: 12, relativeTo: .footnote)
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Code: the voice dock

/// **The voice dock** — a pill directly above the composer, over the chat the
/// call is about. **Code's.**
///
/// Chat and the project overview draw the call inside the composer's shell
/// now (``DesktopVoiceCallBar``); Code's composer is its own and keeps this
/// dock until the Code rework decides its voice UI. It reads the same words
/// and the same hang-up as the call bar, so the two products cannot describe
/// one call differently.
///
/// What this replaced was a 700×560 sheet, and removing it fixed a crash as
/// well as a design mistake: the sheet declared an ideal size and
/// `.interactiveDismissDisabled()`, so when AppKit animated the window's frame
/// SwiftUI had to re-solve a sheet size it could not satisfy, and trapped. A
/// dock sized to its own content has no such solve to fail.
///
/// **No shadows.** It used to lift itself off the page with two warm drop
/// shadows, and its message strips with a third. Glass supplies its own depth,
/// and a shadow on glass is a second rim (§10.2 #2).
struct DesktopVoiceDock: View {
    let column: DesktopVoiceColumn

    @State private var hangUp = DesktopVoiceHangUp()
    /// `motion-safe:animate-rise-in`. Self-driven rather than a `.transition`,
    /// because a transition only plays if whichever screen mounted the dock
    /// wrapped the change in `withAnimation`.
    @State private var risen = false

    /// One read for the rise (Reduce Motion) and the hand-drawn control fills
    /// (Reduce Transparency) — the system swaps the pill's glass for an opaque
    /// backer on its own, but it cannot see a custom `opacity(…)` fill on top.
    @Environment(\.junoAccessibility) private var accessibility

    private var controller: JunoRealtimeVoiceController { column.controller }

    /// `realtime-voice.tsx`'s metrics, in points.
    private enum Metric {
        /// `size-9`.
        static let control: CGFloat = 36
        /// `gap-0.5`.
        static let controlGap: CGFloat = 2
        /// `sm:w-[7.5rem]`: fixed, so "Listening" to "Juno is speaking" does
        /// not slide every control sideways mid-sentence.
        static let statusWidth: CGFloat = 120
        /// `max-w-md`, the cap on anything that carries a sentence.
        static let messageWidth: CGFloat = 448
    }

    var body: some View {
        VStack(spacing: JunoSpace.tight) {
            if let message = DesktopVoiceCallText.failureMessage(controller, saveError: hangUp.saveError) {
                failureBanner(message)
            }
            if let notice = controller.notice {
                noticeBanner(notice)
            }
            pill
        }
        .frame(maxWidth: JunoReadingMeasure.reading)
        .opacity(risen ? 1 : 0)
        .offset(y: risen || accessibility.reduceMotion ? 0 : 8)
        .onAppear {
            withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: accessibility.reduceMotion)) {
                risen = true
            }
        }
        // Ends the call when the column goes, and deliberately does not start
        // one: `start()` is legal from `ended`, so a dock that restarted on
        // appearance would silently redial.
        .onDisappear { controller.end() }
        .accessibilityIdentifier("juno.desktop.voice")
    }

    private var pill: some View {
        JunoDesktopGlass(spacing: Metric.controlGap) {
            HStack(spacing: Metric.controlGap) {
                status
                controls
                optionsMenu
                hangUpButton
            }
            .padding(JunoSpace.hairline)
            .junoGlass(in: Capsule(style: .continuous))
        }
    }

    // MARK: - Words

    private var status: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(DesktopVoiceCallText.statusTitle(controller))
                .junoFont(size: 14, relativeTo: .body, weight: .semibold)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(
                    DesktopVoiceCallText.failureMessage(controller, saveError: hangUp.saveError)
                        ?? DesktopVoiceCallText.statusHelp(controller)
                )
            if let costLabel = DesktopVoiceCallText.costLabel(controller) {
                Text(costLabel)
                    .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
                    .junoSecondaryInk()
                    .lineLimit(1)
                    .help(DesktopVoiceCallText.costDetail(controller))
            }
        }
        .frame(width: Metric.statusWidth, height: Metric.control, alignment: .leading)
        .padding(.leading, JunoSpace.cozy)
        .padding(.trailing, JunoSpace.tight)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func failureBanner(_ message: String) -> some View {
        messageStrip(tint: Color.junoDanger) {
            Text(message)
                .junoFont(size: 12, relativeTo: .callout)
                .lineSpacing(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if case .error(let error) = controller.phase, error.isPermissionDenial {
                Button("Open Privacy Settings") {
                    DesktopVoiceCallText.openPrivacySettings(for: error)
                }
                .buttonStyle(.link)
                .junoFont(size: 12, relativeTo: .callout, weight: .medium)
            }
        }
        .accessibilityIdentifier("juno.desktop.voice-failure")
    }

    private func noticeBanner(_ notice: String) -> some View {
        messageStrip(tint: Color.junoCaution) {
            Label(verbatim: notice, icon: .error)
                .junoFont(size: 12, relativeTo: .callout)
                .lineSpacing(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The shared shape of both strips: a semantic wash and a coloured rim at
    /// 7% and 30%, which is what the web does. No shadow.
    private func messageStrip(
        tint: Color,
        @ViewBuilder content: () -> some View
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
        return VStack(spacing: JunoSpace.hairline, content: content)
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.vertical, JunoSpace.tight)
            .background(tint.opacity(0.07), in: shape)
            .background(Color.junoSurface, in: shape)
            .overlay(shape.strokeBorder(tint.opacity(0.3), lineWidth: 1))
            .frame(maxWidth: Metric.messageWidth)
    }

    // MARK: - Controls

    @ViewBuilder
    private var controls: some View {
        if DesktopVoiceCallText.isRestartable(controller) {
            control(.refresh, label: "Restart voice", tone: .prominent) {
                hangUp.restart(column)
            }
            .accessibilityIdentifier("juno.desktop.voice-restart")
        } else {
            if (controller.capabilities?.screenInput == true || controller.capabilities?.videoInput == true), controller.phase == .live {
                control(
                    controller.screenSharing ? .monitorOff : .monitor,
                    label: controller.screenSharing ? "Stop sharing screen" : "Share screen",
                    tone: controller.screenSharing ? .prominent : .quiet
                ) {
                    if controller.screenSharing {
                        controller.stopScreenShare()
                    } else {
                        controller.startScreenShare()
                    }
                }
                .disabled(controller.phase != .live)
                .accessibilityIdentifier("juno.desktop.voice-share-screen-dock")
            }
            control(
                controller.muted ? .micOff : .mic,
                label: controller.muted ? "Turn microphone on" : "Turn microphone off",
                tone: controller.muted ? .prominent : .quiet
            ) {
                controller.toggleMute()
            }
            .disabled(controller.phase != .live)
            .accessibilityIdentifier("juno.desktop.voice-mute")
        }
    }

    private var optionsMenu: some View {
        Menu {
            Section("Voice model") {
                ForEach(JunoVoiceProvider.allCases) { provider in
                    Button {
                        controller.switchProvider(provider)
                    } label: {
                        if provider == controller.provider {
                            Label(verbatim: provider.displayName, icon: .check)
                        } else {
                            Text(provider.displayName)
                        }
                    }
                    .disabled(provider == controller.provider)
                }
            }
            if controller.capabilities?.screenInput == true || controller.capabilities?.videoInput == true {
                Divider()
                Button {
                    if controller.screenSharing {
                        controller.stopScreenShare()
                    } else {
                        controller.startScreenShare()
                    }
                } label: {
                    Label(
                        verbatim: controller.screenSharing ? "Stop sharing screen" : "Share screen",
                        icon: controller.screenSharing ? .monitorOff : .monitor
                    )
                }
                .accessibilityIdentifier("juno.desktop.voice-share-screen")
            }
        } label: {
            JunoIconView(.chevronDown, size: 14)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    Color.junoMuted.opacity(
                        accessibility.usesOpaqueTransientSurfaces ? 1 : 0.45
                    ),
                    in: Circle()
                )
                .contentShape(Circle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: Metric.control, height: Metric.control)
        .accessibilityLabel("Voice options")
        .accessibilityIdentifier("juno.desktop.voice-options")
    }

    private var hangUpButton: some View {
        Button {
            hangUp.hangUp(column)
        } label: {
            Group {
                if hangUp.isSaving {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    JunoIconView(.phoneOff, size: 15)
                        .foregroundStyle(.white)
                }
            }
            .frame(width: Metric.control, height: Metric.control)
            .background(Color.junoDanger, in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(hangUp.isSaving)
        .help("End and save")
        .accessibilityLabel("End voice conversation")
        .accessibilityIdentifier("juno.desktop.voice-end")
    }

    private enum ControlTone {
        /// `bg-foreground text-background` — the obvious next move.
        case prominent
        /// `bg-muted/65` — present, and not asking for anything.
        case quiet
    }

    private func control(
        _ icon: JunoIcon,
        label: String,
        tone: ControlTone,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            JunoIconView(icon, size: 15)
                // `Color.junoCanvas`, never the `.background` shape style: on
                // glass that resolves translucent, and the one enabled control
                // in an errored session read as disabled.
                .foregroundStyle(tone == .prominent ? Color.junoCanvas : Color.junoForeground)
                .frame(width: Metric.control, height: Metric.control)
                .background(
                    tone == .prominent
                        ? Color.primary
                        : Color.junoMuted.opacity(
                            accessibility.usesOpaqueTransientSurfaces ? 1 : 0.65
                        ),
                    in: Circle()
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }
}

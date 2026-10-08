import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import JunoVoiceKit
import JunoWorkKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Rules

/// Which model the composer sends to, and what "Auto" is called on the wire.
enum ChatComposerModels {
    /// The router's id (`src/lib/auto-model.ts`). The composer's default, so it
    /// always has a model — before the catalog has loaded, after it failed, and
    /// on an account whose conversation named a model it can no longer use.
    static let autoModelID = "juno:auto"
}

extension NativeChatModelOption {
    /// Juno's router rather than a lab's model: the one entry that picks its
    /// own thinking depth, published under the "juno" provider.
    var isJunoAuto: Bool {
        choosesReasoningAutomatically
            || providerID == JunoModelSelectorCatalog.junoProviderID
            || id == ChatComposerModels.autoModelID
    }
}

/// The primary disc's face (§5.3): one 28pt circle that is, in turn, the way
/// into a voice chat, Send, Stop, a wait, or a reason it cannot act.
///
/// A value, resolved by one rule, so the order of precedence is written once
/// and can be tested without a window.
enum ChatComposerFace: Equatable {
    /// An empty draft: start a voice chat. A grey disc, never a second
    /// microphone — Dictate beside it is the microphone.
    case voice
    case send
    case stop
    /// Something the send is waiting on — an upload, or the send itself on its
    /// way out. The reason is the disc's help.
    case busy(String)
    /// Nothing can be sent, and why.
    case disabled(String)

    /// - Parameters:
    ///   - isGenerating: a reply is streaming. Stop wins over everything: it is
    ///     the one thing left to press.
    ///   - blockedReason: why nothing can be sent at all (a spent quota, a file
    ///     that failed to upload). Beats the wait: there is nothing to wait for.
    ///   - waitingReason: what a send is waiting on, if anything.
    ///   - voiceAvailable: whether an empty draft may offer a voice chat. Not in
    ///     a private chat (a call's transcript is filed), not during a call, and
    ///     not where the surface has no call to start. Without it an empty
    ///     draft shows Send, disabled — the web's rule for the same slot.
    static func resolve(
        isGenerating: Bool,
        hasDraft: Bool,
        blockedReason: String?,
        waitingReason: String?,
        voiceAvailable: Bool = true
    ) -> ChatComposerFace {
        if isGenerating { return .stop }
        if let blockedReason { return .disabled(blockedReason) }
        if let waitingReason { return .busy(waitingReason) }
        if hasDraft { return .send }
        return voiceAvailable ? .voice : .disabled("Send")
    }

    /// Identity for the face swap: a change of kind cross-fades, a change of
    /// reason inside one kind does not.
    var kind: String {
        switch self {
        case .voice: "voice"
        case .send: "send"
        case .stop: "stop"
        case .busy: "busy"
        case .disabled: "disabled"
        }
    }

    /// Coral for the three faces that act or are acting; the resting glass
    /// fill for the two that do not (§0.4). The web's fills, through the shell
    /// contract; the Mac's disabled face is the quiet disc, as the web's
    /// disabled Send is.
    var isAccented: Bool {
        shell?.isAccented ?? false
    }

    var isEnabled: Bool {
        switch self {
        case .voice, .send, .stop: true
        case .busy, .disabled: false
        }
    }

    /// The accessible name and the tooltip's first half — the web's copy.
    var label: String {
        switch self {
        case .voice: "Start a voice chat"
        case .send: "Send"
        case .stop: "Stop"
        case .busy(let reason), .disabled(let reason): reason
        }
    }

    /// The tooltip, with the key that does the same thing (§7.1).
    var help: String {
        switch self {
        case .send: "Send  ↩"
        case .stop: "Stop  ⌘."
        default: label
        }
    }

    /// Stable identifiers for UI tests, which predate the spec's labels.
    var identifier: String {
        switch self {
        case .voice: "Start voice conversation"
        case .send: "Send message"
        case .stop: "Stop generating"
        case .busy: "juno.desktop.chat.primary-busy"
        case .disabled: "juno.desktop.chat.primary-disabled"
        }
    }
}

/// The field's placeholder ladder, in the web's order and words
/// (`composer.tsx`, `placeholder`).
///
/// Every rung is here, including the ones later phases reach — a clarifying
/// question (Phase 2), a quoted selection (Phase 4), a running task or research
/// (Phase 5) — so each of those lands by setting its input, not by adding a
/// sentence somewhere else.
enum ChatComposerPlaceholder {
    enum Quote: Equatable {
        case ask
        case modify
    }

    enum Steering: Equatable {
        /// A task asked the reader something.
        case question
        /// A task is running and can take a new instruction.
        case task
        /// A research run is gathering sources.
        case research

        /// The web's words (`delegatedComposerPlaceholder`, `chat-view.tsx`),
        /// its curly apostrophe included.
        var placeholder: String {
            switch self {
            case .question: "Answer Juno\u{2019}s question…"
            case .task: "Add an instruction to the running task…"
            case .research: "Add a constraint, or paste a source to include…"
            }
        }
    }

    /// The web's order: steer mode, then a pending clarification, then a
    /// quote, then the surface's own line (an agent's thread, a private chat),
    /// then the modality's, then "Message Juno…". Armed marks, which blank it
    /// altogether, are the field's to apply.
    static func text(
        isPrivate: Bool = false,
        modality: String = "chat",
        isClarifying: Bool = false,
        quote: Quote? = nil,
        steering: Steering? = nil,
        custom: String? = nil,
        inCall: Bool = false
    ) -> String {
        if let steering { return steering.placeholder }
        // A call is typed into as well as talked to (the web's `voiceOpen`
        // rung). Private mode keeps its own line, as on the web.
        if inCall, !isPrivate { return "Type while you talk…" }
        if isClarifying { return "Or type your own answer…" }
        if let quote {
            return quote == .modify ? "Describe the change…" : "Ask about this selection…"
        }
        if let custom { return custom }
        if isPrivate { return "How can I help you today?" }
        switch modality {
        case "image": return "Describe an image to generate…"
        case "video": return "Describe a video to generate…"
        case "audio": return "Describe a song or a sound to generate…"
        default: return "Ask Alevr"
        }
    }
}

/// An instruction the reader gave a running task that it has not read yet —
/// one row of the queued strip above the field (the web's `PendingSteers`).
struct ChatPendingSteer: Identifiable, Equatable {
    let id: Int
    let text: String
    let at: Date
}

/// The composer talking to a run instead of starting a reply (Phase 5 A6):
/// the web's `steering` prop on `Composer`, built by the conversation from
/// the chat's task (``NativeConversationWork``) or its research run —
/// research wins while it is accepting input (`chat-view.tsx`).
struct ChatComposerSteering {
    enum Kind: Equatable {
        /// The task asked something; the text answers it.
        case answer
        /// The task is working; the text is a new instruction.
        case instruction
        /// A research run is gathering; the text is a constraint or a source.
        case research
    }

    let kind: Kind
    /// Steers with nothing streaming: a task was dispatched minutes ago and
    /// no reply is being written for its whole life. Research steers only
    /// while its turn streams.
    let standalone: Bool
    /// What the disc's Stop face ends, in words: "Stop generating" while a
    /// reply streams, otherwise the run's own.
    let stopLabel: String
    var pending: [ChatPendingSteer] = []
    /// A pinned "now" for the queue's times — the snapshot harness's; nil
    /// reads the clock.
    var clock: Date? = nil
    /// Sends the text; true only when the server took it — the draft clears
    /// only then.
    let steer: (String) async -> Bool
    /// What the Stop face does: the run, then the stream, as the web orders it.
    let stop: () -> Void

    var placeholder: String {
        switch kind {
        case .answer: ChatComposerPlaceholder.Steering.question.placeholder
        case .instruction: ChatComposerPlaceholder.Steering.task.placeholder
        case .research: ChatComposerPlaceholder.Steering.research.placeholder
        }
    }

    var placeholderRung: ChatComposerPlaceholder.Steering {
        switch kind {
        case .answer: .question
        case .instruction: .task
        case .research: .research
        }
    }

    /// The send face's name — the web's, verbatim.
    var sendLabel: String {
        switch kind {
        case .answer: "Answer the task\u{2019}s question"
        case .instruction: "Add this to the running task"
        case .research: "Add to the research"
        }
    }

    /// A task's steering (`workSteering`): standalone, and the Stop face ends
    /// whichever of the two is moving — the reply while it streams, else the
    /// task.
    static func task(
        answering: Bool,
        isGenerating: Bool,
        pending: [ChatPendingSteer],
        steer: @escaping (String) async -> Bool,
        stop: @escaping () -> Void
    ) -> ChatComposerSteering {
        ChatComposerSteering(
            kind: answering ? .answer : .instruction,
            standalone: true,
            stopLabel: isGenerating ? "Stop generating" : "Stop the task",
            pending: pending,
            steer: steer,
            stop: stop
        )
    }

    /// A research run's steering, while it accepts input.
    static func research(
        steer: @escaping (String) async -> Bool,
        stop: @escaping () -> Void
    ) -> ChatComposerSteering {
        ChatComposerSteering(
            kind: .research, standalone: false, stopLabel: "Stop the research",
            steer: steer, stop: stop
        )
    }

    /// Steer mode (`composer.tsx`): steering, and either a reply streaming or
    /// a standalone run — never while a clarification is being answered.
    static func isSteering(
        _ steering: ChatComposerSteering?, isGenerating: Bool, isClarifying: Bool = false
    ) -> Bool {
        guard let steering, !isClarifying else { return false }
        return isGenerating || steering.standalone
    }
}

/// What the disc shows, and what it is called, once steering is weighed in.
///
/// Outside steer mode it is ``ChatComposerFace/resolve(isGenerating:hasDraft:blockedReason:waitingReason:voiceAvailable:)``
/// with the face's own words. In steer mode an empty field is the run's Stop,
/// named for what it ends, and words in the field are its Send, named for
/// where they go — the web's `sendLabel` / `stopLabel`, with the key kept in
/// the tooltip.
struct ChatComposerDisc: Equatable {
    let face: ChatComposerFace
    /// Nil keeps the face's own name.
    let label: String?
    let help: String?

    static func resolve(
        isGenerating: Bool,
        hasDraft: Bool,
        blockedReason: String?,
        waitingReason: String?,
        voiceAvailable: Bool = true,
        steering: (sendLabel: String, stopLabel: String)? = nil
    ) -> ChatComposerDisc {
        guard let steering else {
            return ChatComposerDisc(
                face: ChatComposerFace.resolve(
                    isGenerating: isGenerating, hasDraft: hasDraft, blockedReason: blockedReason,
                    waitingReason: waitingReason, voiceAvailable: voiceAvailable
                ),
                label: nil, help: nil
            )
        }
        if hasDraft {
            if let blockedReason { return ChatComposerDisc(face: .disabled(blockedReason), label: nil, help: nil) }
            if let waitingReason { return ChatComposerDisc(face: .busy(waitingReason), label: nil, help: nil) }
            return ChatComposerDisc(face: .send, label: steering.sendLabel, help: "\(steering.sendLabel)  \u{21A9}")
        }
        return ChatComposerDisc(face: .stop, label: steering.stopLabel, help: "\(steering.stopLabel)  \u{2318}.")
    }
}

/// Why the account cannot send at all, read from the plan route's spend
/// windows (§5.8, Quota).
///
/// The web counts messages against a monthly quota; the native plan route
/// reports the share of each budget window spent, which is what the budget gate
/// enforces — so the sentence names the window that is actually spent rather
/// than the web's "monthly", which would be untrue here.
enum ChatComposerQuota: Equatable {
    /// A plan with no allowance: nothing was used up, so "reached" would be
    /// false on a first visit.
    case noMessages
    case weeklyLimit
    case fiveHourLimit

    init?(plan: NativeUsagePlan?) {
        guard let plan else { return nil }
        self.init(
            isUnlimited: plan.isUnlimited,
            isBrowseOnly: plan.isBrowseOnly,
            weeklyFraction: plan.weekly.fraction,
            sessionFraction: plan.session.fraction
        )
    }

    /// The rule itself, over the four facts it reads, so it can be checked
    /// without a plan decoded from the wire. The week is named before the five
    /// hours when both are spent: it is the longer wait.
    init?(isUnlimited: Bool, isBrowseOnly: Bool, weeklyFraction: Double, sessionFraction: Double) {
        guard !isUnlimited else { return nil }
        if isBrowseOnly {
            self = .noMessages
        } else if weeklyFraction >= 1 {
            self = .weeklyLimit
        } else if sessionFraction >= 1 {
            self = .fiveHourLimit
        } else {
            return nil
        }
    }

    var message: String {
        switch self {
        case .noMessages: "The Free plan doesn't include any messages."
        case .weeklyLimit: "You've reached your weekly limit."
        case .fiveHourLimit: "You've reached your 5-hour limit."
        }
    }

    var action: String {
        switch self {
        case .noMessages: "Upgrade to start chatting"
        case .weeklyLimit, .fiveHourLimit: "Upgrade to keep chatting"
        }
    }
}

/// Something outside the composer asks it to do: ⌘U from the menu bar, a
/// drop on the chat column, or a starter chip.
///
/// A value with an identity rather than a closure, because the composer owns
/// the importer, the attachment rules (a call's four-image ceiling, the error
/// line) and the field's caret, and the column does not; the composer acts on
/// each new id once.
struct ChatComposerRequest: Equatable {
    enum Kind: Equatable {
        case chooseFiles
        case attach([URL])
        /// A starter chip (§4.3): **replace** the draft with this opening, put
        /// the caret after it and focus the field. Never send.
        case seed(String)
        /// A reply's Quote in Composer: the reply, quoted — see
        /// ``ChatComposerRequest/quoted(_:)`` — seeded like a starter chip.
        case quote(String)
        /// A follow-up chip (§6.12): **send** this, as the reader's next
        /// message, with the composer's current model and tools — the web's
        /// `sendFromComposer`.
        case send(String)
        /// "Research this" (the `suggest_research` chip): **send** this as a
        /// Research request (Tool calls & research SPEC §3.8.9, §9.10).
        case research(String)
        /// "Reply Below" on a task's question: put the caret in the field.
        case focus
    }

    let id = UUID()
    let kind: Kind

    /// The web's quote (`message-item.tsx`): the text trimmed, every line
    /// prefixed with `> `, and a blank line after it for the reader's own words.
    static func quoted(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n")
            .map { "> \($0)" }
            .joined(separator: "\n") + "\n\n"
    }
}

/// One message, composed and snapshotted — what a send is, whether it leaves
/// now or waits for the reply in progress.
///
/// Snapshotted because the send is asynchronous: a switch flipped after Return
/// must not change a turn that was already composed.
struct ChatComposerTurn {
    let content: String
    /// Nil starts a new conversation.
    let conversationID: String?
    let projectID: String?
    let modelID: String
    let effort: NativeReasoningEffort?
    let attachmentIDs: [String]
    /// The same files as the message carries them, so the reader's turn shows
    /// them the moment it is sent.
    var attachments: [NativeChatAttachment] = []
    let deepResearch: Bool
    let webSearch: Bool
    let connectors: [String]
    let fastMode: Bool
    let proMode: Bool
    let groundDocuments: Bool
    let documentCount: Int
    /// The skill the message is sent under (`skillSlug`), or nil.
    var skillSlug: String? = nil
    var contextTokens: [NativeContextToken] = []
}

/// A new chat's first send, as the empty state needs to hear of it (§10.1).
///
/// The handoff has to start when Return is pressed, not when the store has
/// created the conversation a round trip later: a composer that sat in the
/// middle of the window for a network's worth of time after Send would read as
/// a send that had not happened. So the composer says so at once — inside the
/// handoff's own transaction — and again when the store has answered.
enum ChatFirstTurnEvent: Equatable {
    /// Return was pressed on a draft. These are the words that left, and the
    /// files that went with them, for the turn that stands in for them until
    /// the store has the real one.
    case began(String, attachments: [NativeChatAttachment] = [])
    /// The store took the turn: the transcript carries it from here.
    case accepted
    /// The store refused it. The words are still in the field; hand back.
    case refused
}

// MARK: - The dock

/// How high the composer group sits in the chat column (§4.1).
enum ChatComposerLift {
    /// A conversation's resting lift, and the floor under a draft's.
    static let resting: CGFloat = JunoSpace.regular

    /// The draft's lift: the group centred in the column as one unit, then
    /// raised 24pt so it sits on the optical centre, which is above the
    /// geometric one.
    ///
    /// §4.1 writes the raise as `− 24` inside the padding; but a bottom padding
    /// *lowers* what it holds as it shrinks, so the sign that honours the
    /// spec's stated intent — "slightly above the true middle" — is `+`.
    ///
    /// - Parameter footerHeight: what hangs below the composer (the starter
    ///   chips). The dock pads the composer, not the group, so the chips'
    ///   height is added back: the padding under the *group* is still the
    ///   centred amount.
    static func draft(columnHeight: CGFloat, groupHeight: CGFloat, footerHeight: CGFloat = 0) -> CGFloat {
        guard columnHeight > 0, groupHeight > 0 else { return resting }
        return max(resting, (columnHeight - groupHeight) / 2 + 24) + footerHeight
    }

    /// The web's `max-w-4xl` group. The composer's own 768 sits inside it;
    /// the greeting and chips hang off the composer and share its width, which
    /// is wider than the greeting's own 672 measure.
    static let groupWidth: CGFloat = 896
}

/// Where the composer is mounted: the chat column's bottom `safeAreaBar`
/// (§4.1, §5.1), gutter-padded and lifted.
///
/// **One mount for both phases.** A draft and a conversation put the composer
/// in the same bar, so the view keeps its identity — its draft, its focus, its
/// attachments — across the first send. What changes is `lift`: in a draft the
/// group (greeting, composer, starter chips) is raised to the column's optical
/// centre; in a conversation it rests 16pt off the bottom.
///
/// **The greeting and the chips hang off the composer; they are not stacked
/// with it.** They are overlays aligned to its top and bottom edges, so they
/// move *with* the composer. In a stack, the handoff went wrong in a way no
/// transition could fix: a view leaving a stack keeps its old offset inside
/// the stack while the stack itself shrinks and slides, so for the length of
/// the fade the chips surfaced above the composer and the greeting slid down
/// past where it had been. Hung off the composer, the pair simply rides down
/// with it as it docks, fading as it goes (§10.1).
///
/// Because the chips hang below the composer rather than sitting in the bar,
/// `lift` is the padding under the **composer**; the host adds the chips'
/// height to a draft's lift (``footerHeightChanged``) so the group, chips and
/// all, is what sits on the optical centre.
struct ChatComposerDock<Header: View, Composer: View, Footer: View>: View {
    /// Bottom padding under the composer — see ``ChatComposerLift``.
    let lift: CGFloat
    /// The column's side margin, shared with the transcript so the draft's
    /// text and the reply's start on one vertical.
    let gutter: CGFloat
    /// Reports the group's own height — greeting, composer and chips, without
    /// `lift` — so the host can centre it. Nil where nothing is centred.
    var groupHeightChanged: ((CGFloat) -> Void)? = nil
    /// Reports the height hanging below the composer, which a draft's lift has
    /// to clear.
    var footerHeightChanged: ((CGFloat) -> Void)? = nil
    /// Above the composer: the greeting, in a draft.
    @ViewBuilder let header: () -> Header
    @ViewBuilder let composer: () -> Composer
    /// Below the composer: the starter chips, in a draft.
    @ViewBuilder let footer: () -> Footer

    @State private var headerHeight: CGFloat = 0
    @State private var composerHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0

    var body: some View {
        composer()
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                composerHeight = height
                report()
            }
            .overlay(alignment: .top) {
                // A stack that always exists, so an empty header measures
                // zero rather than keeping the last greeting's height.
                VStack(spacing: 0) { header() }
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                        headerHeight = height
                        report()
                    }
                    // Its bottom on the composer's top edge.
                    .alignmentGuide(.top) { $0[.bottom] }
            }
            .overlay(alignment: .bottom) {
                VStack(spacing: 0) { footer() }
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                        footerHeight = height
                        footerHeightChanged?(height)
                        report()
                    }
                    // Its top on the composer's bottom edge.
                    .alignmentGuide(.bottom) { $0[.top] }
            }
            .frame(maxWidth: ChatComposerLift.groupWidth)
            .padding(.horizontal, gutter)
            .padding(.bottom, lift)
            .frame(maxWidth: .infinity)
    }

    private func report() {
        groupHeightChanged?(headerHeight + composerHeight + footerHeight)
    }
}

// MARK: - Styles

/// The borderless controls on the composer's row: no bezel, no glass, a hover
/// fill inside the shell, and a small press (§5.2).
///
/// The fill is `junoGlassHover` in a concentric rectangle, which resolves
/// against the shell to the control rung (10): the hover reads as part of the
/// glass rather than as a button laid on it.
struct ComposerControlStyle: ButtonStyle {
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
                .opacity(isEnabled ? 1 : 0.5)
                .background {
                    JunoRadius.concentric()
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

/// The primary disc's press: scale 0.97 and a touch darker, over 70ms (§5.3).
struct ComposerDiscStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Disc(configuration: configuration)
    }

    private struct Disc: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .scaleEffect(configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1)
                .brightness(configuration.isPressed ? -0.06 : 0)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
        }
    }
}

/// The primary disc (§5.3): one flat 28pt circle whose face says what it
/// will do.
///
/// Flat, never glass: a tinted glow under a send button is the one thing that
/// reads most like an AI demo, and the disc never moves, so the pointer does
/// not have to re-find it. Shared by the chat composer, dictation's send and
/// Quick Entry, so every "send this" in the product is the same object in the
/// same place — the grey waveform until there is something to send, then a
/// coral Juno Send in 120ms.
struct ComposerPrimaryDisc: View {
    let face: ChatComposerFace
    /// Overrides the face's own name — dictation's "Send what you dictated".
    var label: String? = nil
    /// Overrides the tooltip; defaults to the label, then the face's own.
    var help: String? = nil
    /// Overrides the face's automation handle.
    var identifier: String? = nil
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            // One disc changing face, as on the iPhone and in ChatGPT: the ink
            // fill stays put and the glyph swaps in place (voice → send →
            // stop) on the send-morph spring. Ink, not the accent: the one
            // filled control in the composer is the darkest thing on the page.
            ZStack {
                Circle()
                    .fill(isInk ? Color.junoForeground : Color.junoGlassFill)
                glyph
            }
            .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
            .contentShape(Circle())
            .animation(JunoMotion.reduced(JunoMotion.sendMorph, when: reduceMotion, tier: .tint), value: face.kind)
        }
        .buttonStyle(ComposerDiscStyle())
        .disabled(!face.isEnabled)
        // No chord here: ⌘. is Chat › Stop Generating in the menu bar, which
        // keeps it while the draft has words and the face has turned to Send.
        .help(help ?? label ?? face.help)
        .accessibilityLabel(label ?? face.label)
        .accessibilityIdentifier(identifier ?? face.identifier)
    }

    private var isInk: Bool {
        switch face {
        case .voice, .send, .stop, .busy: true
        case .disabled: false
        }
    }

    private var symbol: String {
        switch face {
        case .voice: "waveform"
        case .stop: "stop.fill"
        default: "arrow.up"
        }
    }

    @ViewBuilder
    private var glyph: some View {
        switch face {
        case .voice, .send, .stop:
            Image(systemName: symbol)
                .font(.system(size: face.kind == ChatComposerFace.stop.kind ? 10 : 13, weight: .bold))
                .foregroundStyle(Color.junoCanvas)
                .contentTransition(.symbolEffect(.replace.downUp))
        case .busy:
            ProgressView()
                .controlSize(.small)
                .tint(Color.junoCanvas)
                // The small spinner draws in the appearance's ink; the dark
                // appearance is the one whose ink reads on coral.
                .environment(\.colorScheme, .dark)
        case .disabled:
            JunoIconView(.send, size: 14, weight: .bold)
                .foregroundStyle(Color.junoSecondaryInk)
                .opacity(0.5)
        }
    }
}

// MARK: - Paste

/// Routes ⌘V to the composer when the pasteboard holds files or pictures.
///
/// **Why a key monitor.** The draft's `TextField` is an AppKit field editor,
/// and Edit › Paste reaches it before any SwiftUI handler does: a copied file
/// pastes its *name* as text, and a copied picture — which a plain-text editor
/// cannot read — beeps. Neither is what the web does, where a pasted file is
/// attached. A local monitor sees the key first, and swallows it only when the
/// composer's field has focus and there is something to attach; every other ⌘V
/// goes on to the field editor untouched.
@MainActor
final class ChatComposerPasteMonitor {
    private var monitor: Any?
    /// Attaches whatever the pasteboard holds and says whether it did. Set by
    /// the composer that owns this monitor.
    var attach: (() -> Bool)?

    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard Self.isPaste(event) else { return event }
            // Local monitors run on the main thread, inside the event loop.
            let handled = MainActor.assumeIsolated { self?.attach?() ?? false }
            return handled ? nil : event
        }
    }

    func remove() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    nonisolated static func isPaste(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        return flags == [.command] && event.charactersIgnoringModifiers?.lowercased() == "v"
    }

    /// What a paste would attach: file URLs first (a Finder copy also carries
    /// the names as text, and the files are what was meant), then a picture —
    /// but only a picture with no text beside it. A spreadsheet or a word
    /// processor puts an image rendition of the selection next to the text,
    /// and pasting cells must paste the cells, not a photograph of them.
    static func pasteboardAttachments(_ pasteboard: NSPasteboard = .general) -> (urls: [URL], image: Data?) {
        let urls = (pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL]) ?? []
        if !urls.isEmpty { return (urls, nil) }
        guard pasteboard.string(forType: .string) == nil else { return ([], nil) }
        if let png = pasteboard.data(forType: .png) { return ([], png) }
        if let tiff = pasteboard.data(forType: .tiff),
            let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        {
            return ([], png)
        }
        return ([], nil)
    }
}

// MARK: - The composer

/// Chat's composer (§5): the one shell, and everything that happens in it.
///
/// **What it keeps from the composer it replaced.** Every behaviour: sending,
/// stopping, uploads, the screenshot, research, web search, connectors, the
/// reader's own documents, the project a draft is filed under and that
/// project's preferred model, Flash and Pro, a turn spoken into a live call,
/// and the long-draft card. **What it dropped:** the glass on five separate
/// controls, the thinking chip (now in the model popover), the Canvas switch
/// that did nothing, auto-routing that could overrule a model the reader had
/// not chosen against, and the inputs that fed a decorative bloom.
///
/// **Every state is drawn in the one shell (§5.8).** Dictating swaps the field
/// for the words being heard and the controls row for the dictation exits
/// (``ComposerDictationField``, ``ComposerDictationControls``). A call turns
/// the controls row into the call bar (``DesktopVoiceCallBar``), lights the
/// shell's bottom edge with the voice glow (``DesktopVoiceComposerGlow``), and keeps the
/// field, because a call can be typed into. Private mode is this composer with
/// a dashed edge, a footnote and its own placeholder, sending to the in-memory
/// ``NativePrivateChatModel`` instead of the store. None of the three is a
/// second surface: no capsule floats over the shell, and no pill above it.
struct ChatComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let attachmentModel: NativeComposerAttachmentModel?
    let libraryModel: NativeLibraryModel?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    /// Where a project's preferred model is kept. Optional for the reason
    /// ``JunoDesktopConfiguration/projectWorkspaceModel`` is: a composition root
    /// that could not open this Mac's local store has no preferences, and a
    /// composer with none behaves exactly as it did before they existed.
    let workspaceModel: ProjectWorkspaceModel<SQLiteAccountRepository>?
    /// This Mac's local document index. Non-nil is what puts "My Documents"
    /// in the `+` menu at all.
    let documentIndex: NativeDocumentIndexModel?
    let connectorModel: NativeConnectorModel?
    /// The chat's task or research run, when the composer can talk to it
    /// (Phase 5 A6). In steer mode Return goes to the run, an empty field's
    /// disc is the run's Stop, and the queued instructions sit above the field.
    var steering: ChatComposerSteering? = nil
    /// The surface's own placeholder rung — an agent's thread says "Message
    /// {name}…". Below steering, a clarification and a quote, as on the web.
    var customPlaceholder: String? = nil
    /// The synced account settings, for the `+` menu's Memory switch.
    let memorySettings: NativeMemorySettingsModel<SQLiteAccountRepository>?
    @Binding var draftProjectID: String?
    @Binding var draftPrompt: String?
    let openVoiceMode: (String) -> Void
    /// Locks this composer to a project and always starts a new conversation —
    /// the project overview, which is the same composer as Chat rather than a
    /// prompt-shaped imitation of it.
    var fixedProjectID: String? = nil
    /// Called after the first message is accepted, so an embedded project
    /// composer can move to the transcript it just created.
    var didSendConversation: ((String) -> Void)? = nil
    /// The private chat this composer sends to while the route is private
    /// (§5.8, Private). Non-nil is also private mode's look — the dashed edge,
    /// the footnote, the placeholder — and a `+` menu without research,
    /// projects, connectors, files, web search or local documents, none of
    /// which a private turn can carry.
    ///
    /// Nothing a private turn does reaches the store: no conversation row, no
    /// outbox entry, no sync. The model holds the transcript in memory, and the
    /// window drops it when private mode ends.
    var privateChat: NativePrivateChatModel? = nil
    /// Hears about a new chat's first send, for the empty state's handoff
    /// (§10.1). Nil where there is no empty state to hand off from — the
    /// project overview, which moves to the transcript it created instead.
    var onFirstTurn: ((ChatFirstTurnEvent) -> Void)? = nil
    /// Why this account cannot send, if it cannot.
    var quota: ChatComposerQuota? = nil
    /// A file is being dragged over the chat column.
    var isDropTargeted = false
    /// The latest request from outside — ⌘U, a drop — acted on once per id.
    var request: ChatComposerRequest? = nil
    /// ↑ in an empty field: reopen the last message for editing.
    var editLastMessage: (() -> Void)? = nil
    /// "Manage Connections…" in the `+` menu. Nil leaves the row out.
    var manageConnections: (() -> Void)? = nil
    /// The skills library (Phase 4 B): "Use a Skill" and a typed `/slug`,
    /// sent as `skillSlug`. Nil leaves both out.
    var skillLibrary: NativeSkillLibraryModel? = nil
    /// "Manage Skills…" in Use a Skill. Nil leaves the row out.
    var manageSkills: (() -> Void)? = nil
    /// The quota line's link. Nil draws the sentence alone.
    var openUpgrade: (() -> Void)? = nil
    /// Hears whether the draft is empty — nothing typed, nothing attached —
    /// for the follow-up chips above it, which show only then.
    var draftIsEmptyChanged: ((Bool) -> Void)? = nil

    @State private var prompt = ""
    /// Empty only until the first ``configureSelection()`` on appear, which
    /// resolves it — to the conversation's own model when it has one, and to
    /// Auto otherwise. Starting at Auto instead would pin every conversation
    /// the window opens on to Auto, because a selectable current pick wins.
    @State private var selectedModelID = ""
    @State private var thinkingStopID = ""
    @State private var deepResearch = false
    /// The skill armed for the next message, by its slash name. Per-send, as
    /// research is, and as the web's is.
    @State private var contextTokens: [NativeContextToken] = []
    @State private var skillSlug: String?
    /// A steer is on its way to the run; a second Return waits for it.
    @State private var isSteeringInFlight = false
    @State private var webSearch = false
    // @AppStorage rather than @State: preferences that survive a relaunch, as
    // the web keeps them in localStorage and the phone in UserDefaults.
    @AppStorage("juno.desktop.composer.fast-mode") private var fastMode = false
    @AppStorage("juno.desktop.composer.pro-mode") private var proMode = false
    /// Whether a turn may quote this Mac's own document index.
    ///
    /// **Off by default, and that default is the point.** Importing a file into
    /// the Library is consent to *search* it on this machine, not standing
    /// consent to put paragraphs of it into every question that leaves the Mac.
    @AppStorage("juno.desktop.composer.document-context") private var documentContext = false
    /// What grounding did on the last send, in one sentence — "your documents
    /// were quoted" and "searched and nothing matched" must be told apart from
    /// outside, or the safe assumption (they were read) is wrong half the time.
    @State private var groundingNote: String?
    /// Whether the reader chose a model in this composer since the conversation
    /// was selected. It cannot be derived from `selectedModelID`, which is also
    /// what ``configureSelection()`` resolves — "this model because I said so"
    /// and "this model because it was first" are the same string.
    @State private var modelChosenByReader = false
    @State private var selectedProjectID: String?
    @State private var selectedConnectors: Set<String> = []
    @State private var showingFileImporter = false
    @State private var showingLibrary = false
    @State private var showingNewProject = false
    /// The dictation in progress, if the reader is dictating. Dropping it is
    /// what tears the recognizer down.
    @State private var dictation: ComposerDictationSession?
    /// Hanging up a call, and a save that failed afterwards. Held here because
    /// the call bar and the line above the shell are two views of it.
    @State private var voiceHangUp = DesktopVoiceHangUp()
    /// Where the caret is. Written only when something puts words in the field
    /// for the reader — a starter chip, a follow-up — so it lands after them:
    /// a field that takes focus on macOS otherwise selects everything in it,
    /// and the first key typed would replace the words just seeded.
    @State private var selection: TextSelection?
    @State private var importError: String?
    /// Set while a spoken turn is on the wire, so a second Return cannot send
    /// the same images twice.
    @State private var isSendingVoiceTurn = false
    @State private var voiceTurnError: String?
    /// Why a new chat's first turn came back. In a draft there is no
    /// transcript to carry the store's error, so without this line a refused
    /// first send would return to the middle of the window with nothing said.
    @State private var firstTurnError: String?
    /// Set from Return until the store accepts or refuses the turn: grounding
    /// and creating the conversation happen in between.
    @State private var isDispatching = false
    /// Exactly one message typed while a reply streams (§5.8). A second is
    /// refused, and its words stay in the field.
    @State private var queuedTurn: ChatComposerTurn?
    /// Whether a very large draft has been opened back up for editing. The text
    /// is in `prompt` and sent in full either way.
    @State private var draftExpanded = false
    @State private var composerWidth: CGFloat = 0
    /// A reply has streamed past ``beamBeat``: the beam may travel.
    @State private var streamedPastBeat = false
    /// Mirrors the environment's call for the paste monitor, which runs outside
    /// a body evaluation and so must read state, not a stale environment copy.
    @State private var isInCall = false
    @State private var pasteMonitor = ChatComposerPasteMonitor()
    @FocusState private var focused: Bool
    @FocusState private var collapsedDraftFocused: Bool
    /// The dictation row, which takes the keyboard so Esc cancels and Return
    /// sends while the field is not on screen.
    @FocusState private var dictationFocused: Bool
    /// The call this composer is inside, published by ``SwiftUI/View/junoVoiceCall(_:)``.
    /// Non-nil routes a send over the socket instead of to `/api/chat`.
    @Environment(\.junoVoiceCall) private var voiceCall
    /// The transcript's media loader: a sent picture's bytes are handed to it
    /// here, so the reader's own turn draws the photo at once instead of
    /// fetching back what this Mac just uploaded.
    @Environment(\.junoTranscriptMedia) private var transcriptMedia
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // MARK: Derived state

    private var selectedModel: NativeChatModelOption? {
        model.model(withID: selectedModelID)
    }

    private var thinkingScale: NativeThinkingScale? {
        selectedModel.map(NativeThinkingScale.init(model:))
    }

    private var reasoningEffort: NativeReasoningEffort? {
        thinkingScale?.stops.first { $0.id == thinkingStopID }?.effort
    }

    private var effortBinding: Binding<NativeReasoningEffort?> {
        Binding(
            get: { reasoningEffort },
            set: { effort in
                guard let scale = thinkingScale else { return }
                thinkingStopID = scale.stopID(for: effort) ?? scale.defaultStop?.id ?? ""
            }
        )
    }

    private var voiceActive: Bool { voiceCall != nil }

    private var isPrivate: Bool { privateChat != nil }

    private var dictating: Bool { dictation != nil }

    /// A reply is streaming — the store's, or the private chat's.
    private var isGenerating: Bool {
        privateChat?.isStreaming ?? model.isGenerating
    }

    /// How long a reply streams before the beam starts: a short answer should
    /// not flash an effect at the reader.
    private static let beamBeat: Duration = .seconds(3)

    /// Past four images a turn, providers answer about the first and ignore the
    /// rest. The relay enforces the same ceiling; this stops the reader first.
    private static let maximumVoiceImages = 4

    /// Whether the model on the other end of the call can see at all, from what
    /// the relay said in `session.ready`. Nil while connecting reads as no.
    private var voiceCanSeeImages: Bool {
        voiceCall?.controller.capabilities?.videoInput == true
    }

    private var indexedDocumentCount: Int {
        documentIndex?.documents.count ?? 0
    }

    /// Whether the next send will search this Mac's documents. A lit switch
    /// over an empty index would promise something that cannot happen, and a
    /// spoken turn carries none of the text this grounding extends.
    private var documentGroundingArmed: Bool {
        documentContext && indexedDocumentCount > 0 && !voiceActive
    }

    private var draftIsEmpty: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (attachmentModel?.attachments.isEmpty ?? true)
    }

    private var hasFailedAttachment: Bool {
        attachmentModel?.attachments.contains { if case .failed = $0.state { true } else { false } } ?? false
    }

    private var isUploading: Bool { attachmentModel?.isUploading ?? false }

    /// Why nothing can be sent at all — the disabled face's reason.
    private var blockedReason: String? {
        if let quota { return quota.message }
        if !draftIsEmpty, hasFailedAttachment {
            return "Remove the file that didn't upload, or try it again."
        }
        return nil
    }

    /// What a send is waiting on — the busy face's reason.
    private var waitingReason: String? {
        if isDispatching || isSendingVoiceTurn { return "Sending your message" }
        if !draftIsEmpty, isUploading { return "Waiting for the upload to finish" }
        return nil
    }

    /// Steer mode (Phase 5 A6): the composer talks to the chat's run. Never
    /// during a call, whose disc is the call's, and never in a private chat,
    /// which has no run.
    private var inSteerMode: Bool {
        !voiceActive && !isPrivate
            && ChatComposerSteering.isSteering(steering, isGenerating: isGenerating)
    }

    private var disc: ChatComposerDisc {
        ChatComposerDisc.resolve(
            isGenerating: isGenerating,
            hasDraft: !draftIsEmpty,
            blockedReason: blockedReason,
            waitingReason: isSteeringInFlight ? "Sending your message" : waitingReason,
            // A call's transcript is filed as a conversation, so a private
            // chat has none to offer; and during a call the disc is the call's.
            voiceAvailable: !isPrivate && !voiceActive,
            steering: inSteerMode ? steering.map { ($0.sendLabel, $0.stopLabel) } : nil
        )
    }

    private var face: ChatComposerFace { disc.face }

    /// Whether Return may send (or queue) right now.
    private var canSubmit: Bool {
        !draftIsEmpty
            && blockedReason == nil
            && !isDispatching
            && !isSendingVoiceTurn
            && (attachmentModel?.canSend ?? true)
    }

    private var placeholder: String {
        ChatComposerPlaceholder.text(
            isPrivate: isPrivate,
            modality: selectedModel?.modality ?? "chat",
            steering: inSteerMode ? steering?.placeholderRung : nil,
            custom: customPlaceholder,
            inCall: voiceActive
        )
    }

    /// Whether the draft is long enough that sending it as a file is worth
    /// offering. An offer, never a rule — see ``NativePromptLimits``.
    private var isLongDraft: Bool {
        canAttachDraft && NativePromptLimits.isLongDraft(prompt)
    }

    /// Past this the draft leaves the text field and shows as a card: tens of
    /// thousands of characters in an auto-sizing field re-measure on every
    /// keystroke, and the composer stops taking input long before Send.
    private var showsCollapsedDraft: Bool {
        NativePromptLimits.isHugeDraft(prompt) && !draftExpanded
    }

    private var canAttachDraft: Bool {
        !isPrivate && (attachmentModel?.hasCapacity ?? false)
    }

    private var canAttach: Bool {
        // The server refuses a private turn that carries files
        // (`private_attachments_unsupported`), so the composer does first.
        guard quota == nil, !isPrivate, let attachmentModel else { return false }
        if voiceActive {
            return voiceCanSeeImages && attachmentModel.attachments.count < Self.maximumVoiceImages
        }
        return attachmentModel.hasCapacity
    }

    private var connectedConnectors: [NativeConnector] {
        (connectorModel?.linked ?? []).filter(\.connected)
    }

    /// The project whose preferences apply: the fixed one wins, because a
    /// project overview's composer cannot be filed anywhere else.
    private var activeProjectID: String? {
        fixedProjectID ?? selectedProjectID
    }

    /// The project's preferred model, when it applies. The rule is
    /// ``ProjectPreferredModel/resolve(preferredModelID:readerChoseExplicitly:selectableModelIDs:)``,
    /// shared with the phone so the two cannot grow different precedences.
    private var projectPreferredModelID: String? {
        guard let activeProjectID, let workspaceModel else { return nil }
        return ProjectPreferredModel.resolve(
            preferredModelID: workspaceModel.workspaces[activeProjectID]?.preferredModelID,
            readerChoseExplicitly: modelChosenByReader,
            selectableModelIDs: model.selectableModels.map(\.id)
        )
    }

    private var researchAvailable: Bool {
        !isPrivate && (selectedModel?.modality ?? "chat") == "chat"
    }

    private var webSearchAvailable: Bool {
        selectedModel?.supportsWebSearch == true
    }

    /// Whether a skill can be armed here: not in a private chat, not in a
    /// call (a skill's method is written to be read), and only with the
    /// library.
    private var skillsAvailable: Bool {
        skillLibrary != nil && !isPrivate && !voiceActive
    }

    private var armedSkill: (slug: String, name: String?, description: String?)? {
        guard skillsAvailable, let skillSlug else { return nil }
        let choice = skillLibrary?.chooseable.first { $0.slug == skillSlug }
        return (skillSlug, choice?.name, choice?.description)
    }

    private var marks: [ChatComposerMark] {
        ChatComposerMark.marks(
            skill: armedSkill,
            research: deepResearch && researchAvailable,
            webSearch: webSearch && webSearchAvailable,
            connectors: isPrivate || voiceActive ? [] : connectedConnectors
                .filter { selectedConnectors.contains($0.id) }
                .map { (id: $0.id, label: $0.label) },
            documentCount: documentGroundingArmed ? indexedDocumentCount : nil
        )
    }

    /// The queued strip's identity, for its rise and its leaving.
    private var pendingSteerIDs: [Int] {
        steering?.pending.map(\.id) ?? []
    }

    private var pendingSteerMotion: Animation? {
        JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion)
    }

    // MARK: Body

    var body: some View {
        JunoComposerShell(
            captionAbove: { captionsAbove },
            above: { aboveSlot },
            field: { fieldRow },
            controls: { controlsRow },
            edge: { edges },
            captionBelow: { captionBelow }
        )
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { composerWidth = $0 }
        .task(id: isGenerating) {
            streamedPastBeat = false
            guard isGenerating else { return }
            try? await Task.sleep(for: Self.beamBeat)
            if !Task.isCancelled, isGenerating { streamedPastBeat = true }
        }
        .onPasteCommand(of: [.fileURL, .image, .png, .tiff]) { _ in
            _ = attachFromPasteboard()
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: voiceActive ? [.image] : [.item],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .failure(let error): importError = error.localizedDescription
            case .success(let urls): attach(urls, securityScoped: true)
            }
        }
        .sheet(isPresented: $showingLibrary) {
            if let libraryModel, let attachmentModel {
                DesktopLibraryPicker(
                    model: libraryModel,
                    capacity: max(
                        0,
                        NativeComposerAttachmentModel.maximumAttachments - attachmentModel.attachments.count
                    ),
                    attach: {
                        if let uploaded = await libraryModel.attachSelection() {
                            attachmentModel.adopt(uploaded)
                            showingLibrary = false
                        }
                    },
                    cancel: {
                        libraryModel.selection = []
                        showingLibrary = false
                    }
                )
            }
        }
        .sheet(isPresented: $showingNewProject) {
            if let projectModel {
                DesktopNewProjectForm(model: projectModel) { projectID in
                    selectedProjectID = projectID
                }
            }
        }
        .onAppear {
            // Project before model, and the order is load-bearing: a project's
            // preferred model is part of what `configureSelection()` answers, so
            // resolving first would show the account default for a frame and
            // then jump to the project's model in front of the reader.
            if let fixedProjectID { selectedProjectID = fixedProjectID }
            consumeDraftProject()
            configureSelection()
            consumeDraftPrompt()
            focused = true
            isInCall = voiceActive
            armPasteMonitor()
            pasteMonitor.install()
        }
        // Every transient presentation is torn down with the composer: a sheet
        // or importer whose presenter vanishes mid-presentation is the crash
        // class rule 2 exists for.
        .onDisappear {
            showingLibrary = false
            showingFileImporter = false
            showingNewProject = false
            pasteMonitor.remove()
            // A recognizer left running with nothing on screen is a live
            // microphone nobody can see.
            dictation?.cancel()
        }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: showsCollapsedDraft)
        // The queued strip rises in with a steer and leaves as the run reads it.
        .animation(pendingSteerMotion, value: pendingSteerIDs)
        // Once the draft is back under the inline ceiling, forget it was ever
        // expanded — otherwise the next huge paste lands straight in the field.
        .onChange(of: prompt) { _, text in
            if !NativePromptLimits.isHugeDraft(text) { draftExpanded = false }
            firstTurnError = nil
        }
        // A refused first send stays said until the reader edits the words or
        // moves to a chat with a transcript of its own — not when the store
        // quietly settles or drops the conversation it tried to create.
        .onChange(of: model.selectedConversationID) { _, selected in
            if let selected, !model.messages(for: selected).isEmpty { firstTurnError = nil }
        }
        .onChange(of: voiceActive) { _, active in
            isInCall = active
            armPasteMonitor()
            // A refusal that named the call means nothing once it is over.
            if !active { voiceTurnError = nil }
            if active {
                // A new call starts clean, and a call and a dictation cannot
                // share the microphone.
                voiceHangUp.reset()
                if dictation != nil { cancelDictation() }
            }
        }
        // Private mode on or off: a turn queued for the other side of the line
        // does not cross it, and a note about the last send is about a chat
        // that is no longer on screen.
        .onChange(of: isPrivate) { _, _ in
            queuedTurn = nil
            groundingNote = nil
            // The monitor's handler holds the composer as it was when armed,
            // private mode included; left stale, a pasted file would slip past
            // `canAttach` into a private chat that cannot send it.
            armPasteMonitor()
        }
        .onChange(of: quota) { _, _ in armPasteMonitor() }
        .onChange(of: model.modelCatalog) { _, _ in configureSelection() }
        .onChange(of: model.selectedConversationID) { _, selected in
            // A pick is about the conversation it was made in; moving on
            // retires it so the next conversation's project preference applies.
            modelChosenByReader = false
            // A note about the last send describes a message in the chat it
            // went to. Carried into another it is a claim about nothing on screen.
            groundingNote = nil
            if let fixedProjectID {
                selectedProjectID = fixedProjectID
            } else {
                selectedProjectID = selected == nil ? nil : model.selectedConversation?.projectId
            }
            configureSelection()
            if selected == nil { selectedConnectors = [] }
        }
        // The reader filing the draft under another project, or the preference
        // being edited on the Projects page while this composer is open.
        .onChange(of: projectPreferredModelID) { _, _ in configureSelection() }
        .onChange(of: documentContext) { _, _ in groundingNote = nil }
        .onChange(of: draftProjectID) { _, _ in consumeDraftProject() }
        .onChange(of: draftPrompt) { _, _ in consumeDraftPrompt() }
        .onChange(of: selectedModelID) { _, _ in configureThinking() }
        // Pro composes with effort rather than replacing it, and Pro at
        // Instant is a contradiction the web resolves by raising effort to
        // Medium; so does this.
        .onChange(of: proMode) { _, isOn in
            guard isOn, thinkingStopID == JunoThinkingLadder.instantStopID,
                let medium = thinkingScale?.stopID(for: .medium)
            else { return }
            thinkingStopID = medium
        }
        // The reply the queued turn was waiting on has ended.
        .onChange(of: isGenerating) { _, generating in
            guard !generating, let queued = queuedTurn else { return }
            queuedTurn = nil
            dispatch(queued, restoreOnRefusal: true)
        }
        .onChange(of: request?.id) { _, _ in
            guard let request else { return }
            switch request.kind {
            case .chooseFiles:
                if canAttach { showingFileImporter = true }
            case .attach(let urls):
                attach(urls, securityScoped: false)
            case .seed(let opening):
                seed(opening)
            case .quote(let text):
                seed(ChatComposerRequest.quoted(text))
            case .send(let text):
                // Only ever offered over an empty draft, so nothing the
                // reader wrote is replaced.
                guard draftIsEmpty else { return }
                prompt = text
                submit()
            case .research(let question):
                // "Research this": the question, sent as Research — only over
                // an empty draft, like a follow-up.
                guard draftIsEmpty, researchAvailable, DesktopPlanGate.shared.require(.research) else { return }
                deepResearch = true
                prompt = question
                submit()
            case .focus:
                // Chat › Focus Composer (⇧⎋) and a question's Reply Below: the
                // caret after what is there, as the web's ⇧Esc puts it.
                focused = true
                placeCaretAtEnd()
            }
        }
        .onChange(of: draftIsEmpty, initial: true) { _, isEmpty in
            draftIsEmptyChanged?(isEmpty)
        }
        // Chat › Stop Generating (⌘.): the menu bar owns the chord now, and
        // this is what it stops — published only while there is something to.
        .focusedSceneValue(\.junoComposerStop, stopCommand)
    }

    // MARK: Slots

    @ViewBuilder
    private var captionsAbove: some View {
        let showsProjectCapsule = fixedProjectID == nil && !isPrivate
            && model.selectedConversationID == nil && selectedProjectName != nil
        let showsCallNotice = voiceCall.map {
            $0.controller.notice != nil
                || DesktopVoiceCallText.failureMessage($0.controller, saveError: voiceHangUp.saveError) != nil
        } ?? false
        if quota != nil || showsProjectCapsule || queuedTurn != nil || errorLine != nil || groundingNote != nil
            || showsCallNotice
        {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                if let voiceCall, showsCallNotice {
                    DesktopVoiceCallNotices(column: voiceCall, hangUp: voiceHangUp)
                }
                if let quota {
                    quotaCaption(quota)
                }
                if showsProjectCapsule, let name = selectedProjectName {
                    projectCapsule(name)
                }
                if let queuedTurn {
                    queuedCaption(queuedTurn)
                }
                if let errorLine {
                    caption(errorLine, icon: .error, ink: Color.junoDestructiveInk)
                        .accessibilityIdentifier("juno.desktop.chat.composer-error")
                }
                if let groundingNote {
                    caption(groundingNote, icon: .fileSearch, ink: Color.junoSecondaryInk)
                        .accessibilityIdentifier("juno.desktop.chat.document-context-note")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var aboveSlot: some View {
        if !isPrivate, !voiceActive {
            NativeContextSuggestions(query: NativeContextMention.query(in: prompt), search: {
                try await model.mentions(query: $0, conversationID: model.selectedConversationID)
            }, select: { token in
                guard contextTokens.count < 16 else { return }
                if !contextTokens.contains(where: { $0.identity == token.identity }) { contextTokens.append(token) }
                prompt = NativeContextMention.inserting(token, in: prompt)
            })
        }
        // The instructions the run has not read yet, rising in the moment the
        // server takes one and leaving when the run reads it — the steering
        // composer's one signature.
        if let pending = steering?.pending, !pending.isEmpty, !isPrivate {
            ComposerPendingSteers(steers: pending, now: steering?.clock)
                .transition(
                    .asymmetric(
                        insertion: .opacity.combined(with: .offset(y: JunoMotion.shift(4, reduceMotion: reduceMotion))),
                        removal: .opacity
                    )
                )
        }
        if let attachmentModel, !attachmentModel.attachments.isEmpty {
            ComposerAttachmentTiles(
                attachments: attachmentModel.attachments,
                remove: { attachmentModel.remove($0) },
                retry: { attachmentModel.retry($0, conversationID: model.selectedConversationID) }
            )
        }
        if !dictating {
            if showsCollapsedDraft {
                collapsedDraftCard
            } else if isLongDraft {
                attachAsFileHint
            }
        }
    }

    @ViewBuilder
    private var fieldRow: some View {
        if let dictation {
            ComposerDictationField(session: dictation)
                .focusable()
                .focused($dictationFocused)
                // Esc cancels (§5.9: after a quote, before a reply); Return
                // sends what was heard, as it does from the field.
                .onKeyPress(.escape) {
                    cancelDictation()
                    return .handled
                }
                .onKeyPress(.return, phases: .down) { _ in
                    if dictation.hasWords { sendDictation() }
                    return .handled
                }
                .onAppear { dictationFocused = true }
                .transition(.opacity)
        } else if !showsCollapsedDraft {
            HStack(alignment: .top, spacing: JunoSpace.tight) {
                if !marks.isEmpty {
                    armedMarks
                        .padding(.top, 1)
                }
                draftField
            }
            .opacity(isDropTargeted ? 0.3 : 1)
        }
    }

    @ViewBuilder
    private var controlsRow: some View {
        if let voiceCall {
            // The call, in the row the controls were in. `+` stays at the head
            // (a picture can be shown to a call), and the primary slot ends
            // the call until something is typed, when it is Send.
            DesktopVoiceCallBar(
                column: voiceCall,
                hangUp: voiceHangUp,
                hasDraft: !draftIsEmpty,
                leading: { plusMenu },
                primary: { primaryDisc }
            )
            .opacity(isDropTargeted ? 0.3 : 1)
            .transition(.opacity)
        } else if let dictation {
            ComposerDictationControls(
                session: dictation,
                cancel: cancelDictation,
                stop: stopDictation
            ) {
                ComposerPrimaryDisc(
                    face: dictation.hasWords ? .send : .disabled("Send what you dictated"),
                    label: "Send what you dictated",
                    identifier: "juno.desktop.dictation-send",
                    action: sendDictation
                )
            }
            .transition(.opacity)
        } else {
            HStack(spacing: JunoComposerMetrics.controlSpacing) {
                HStack(spacing: JunoComposerMetrics.controlSpacing) {
                    plusMenu
                    Spacer(minLength: JunoSpace.snug)
                    modelChip
                    // Steering is text only: the mic steps aside (the web's).
                    if JunoSpeechService.isSupported, !inSteerMode {
                        dictateButton
                    }
                }
                // While a reply streams, everything but the disc steps back:
                // Stop is the one thing left to press. Still live — a switch
                // flipped now applies to the next send.
                .opacity(isGenerating ? 0.6 : 1)
                primaryDisc
            }
            .opacity(isDropTargeted ? 0.3 : 1)
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var edges: some View {
        if isDropTargeted {
            JunoComposerDropEdge(label: "Drop to attach")
        } else if let voiceCall {
            // The voice glow (premium voice pass): a band of light along the
            // shell's bottom edge that rises with the voice and gathers into a
            // travelling beam while the reply is thought through. Clipped to
            // the shell, so it follows its corners and never reaches the page.
            DesktopVoiceComposerGlow(controller: voiceCall.controller)
                .clipShape(ContainerRelativeShape())
                .transition(.opacity)
        } else if isPrivate {
            JunoComposerPrivateEdge()
        }
    }

    /// The one quiet line under the dock (the web's `footnote`): what is
    /// different about this chat outranks the standing notice. Docked
    /// conversations only, never the landing, which carries its own header.
    var footnote: String? {
        guard fixedProjectID == nil else { return nil }
        if let privateChat {
            guard !privateChat.isEmpty else { return nil }
            return privateChat.isFork
                ? "This branch isn\u{2019}t saved. It continues from the fork point with full context."
                : "Incognito chats are not saved or added to memory."
        }
        guard model.selectedConversationID != nil else { return nil }
        return "Alevr can make mistakes. Check important info."
    }

    @ViewBuilder
    private var captionBelow: some View {
        if let footnote {
            // Secondary rather than tertiary ink: tertiary is below 3:1 on the
            // light canvas, and at 11pt this line is the whole promise. A
            // fixed slot, so every docked chat sits at the same height.
            Text(footnote)
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
                .multilineTextAlignment(.center)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity)
                .frame(height: 16)
                .accessibilityIdentifier("juno.desktop.composer.footnote")
        }
    }

    // MARK: Field

    private var draftField: some View {
        TextField(
            text: $prompt,
            selection: $selection,
            // No placeholder while a mark is in the line: the marks are the
            // start of the sentence, and a placeholder after them reads as a
            // second sentence.
            prompt: Text(marks.isEmpty ? placeholder : "").foregroundStyle(Color.junoSecondaryInk),
            axis: .vertical
        ) {
            Text(placeholder)
        }
        .textFieldStyle(.plain)
        // The body rung asks for a 1.6 line height, and this field does not
        // honour it (errata 13, measured on macOS 27): four lines of draft are
        // 76pt, the font's natural 19pt a line against the web's 24, and
        // `.lineSpacing` is ignored as well. The field keeps the rung for its
        // size and tracking; the leading waits on a text-view-backed field.
        .junoType(.body)
        .foregroundStyle(Color.junoForeground)
        .lineLimit(1...8)
        .focused($focused)
        .accessibilityIdentifier("Message Juno")
        // Return sends; Shift-Return breaks the line — every chat surface's
        // rule, Juno's web composer included, and why the disc carries no
        // Return shortcut of its own. A vertical `TextField` inserts a newline
        // on Return, so the key is intercepted rather than bound.
        .onKeyPress(.return, phases: .down) { press in
            if press.modifiers.contains(.shift) { return .ignored }
            submit()
            // Swallowed even when nothing could be sent: Return must not quietly
            // grow the field instead of doing what was asked.
            return .handled
        }
        // ↑ in an empty field reopens the last message, as the web's does.
        .onKeyPress(.upArrow) {
            guard prompt.isEmpty, !isGenerating, let editLastMessage else { return .ignored }
            editLastMessage()
            return .handled
        }
        // Esc stops a reply in flight. (A quoted selection, from Phase 4, is
        // cleared before this; dictation has its own Esc.)
        .onKeyPress(.escape) {
            guard isGenerating else { return .ignored }
            stopGeneration()
            return .handled
        }
    }

    // MARK: Marks

    @ViewBuilder
    private var armedMarks: some View {
        let split = ChatComposerMark.visible(marks)
        // ONE mark always keeps its words: a lone telescope says nothing where
        // "Research" says all of it. Two or more drop to glyphs on a
        // narrow composer.
        let showsLabels = marks.count == 1
            || composerWidth == 0
            || composerWidth >= ChatComposerMark.labelMinimumWidth
        HStack(spacing: JunoSpace.hairline) {
            ForEach(split.shown) { mark in
                ComposerArmedMarkView(
                    mark: mark,
                    showsLabel: showsLabels,
                    disarm: { disarm(mark.id) },
                    menu: { ComposerPlusMenu(menu: plusMenuModel) }
                )
            }
            if !split.rest.isEmpty {
                ComposerArmedMarkView(
                    mark: ChatComposerMark.overflow(for: split.rest),
                    // The count is the information; "⋯" alone says nothing.
                    showsLabel: true,
                    disarm: { split.rest.forEach { disarm($0.id) } },
                    menu: { ComposerPlusMenu(menu: plusMenuModel) }
                )
            }
        }
        .fixedSize()
    }

    private func disarm(_ id: String) {
        switch id {
        case ChatComposerMark.skillID: skillSlug = nil
        case ChatComposerMark.researchID: deepResearch = false
        case ChatComposerMark.webSearchID: webSearch = false
        case ChatComposerMark.documentsID: documentContext = false
        default:
            if id.hasPrefix(ChatComposerMark.connectorPrefix) {
                selectedConnectors.remove(String(id.dropFirst(ChatComposerMark.connectorPrefix.count)))
            }
        }
    }

    // MARK: Controls

    private var plusMenuModel: ComposerPlusMenuModel {
        let isDraft = fixedProjectID != nil || model.selectedConversationID == nil
        return ComposerPlusMenuModel(
            // During a call the Mac takes photos only; the web's call offers
            // files as well (its `voice-files` row). The ellipsis is the Mac's.
            attachTitle: voiceActive ? "Add Photos…" : "\(JunoShellPlusRow.files.title)…",
            canAttach: canAttach,
            attachUnavailableReason: isPrivate ? "Incognito" : nil,
            addFiles: { showingFileImporter = true },
            takeScreenshot: voiceActive ? nil : { takeScreenshot() },
            addFromLibrary: libraryModel == nil ? nil : { showingLibrary = true },
            canAddFromLibrary: canAttach && !voiceActive,
            projects: fixedProjectID == nil && !isPrivate && !voiceActive
                ? projectModel?.projects : nil,
            currentProjectID: isDraft ? selectedProjectID : model.selectedConversation?.projectId,
            chooseProject: { chooseProject($0) },
            newProject: isDraft && projectModel != nil ? { showingNewProject = true } : nil,
            connectors: connectorModel == nil || isPrivate || voiceActive ? nil : connectedConnectors,
            connectorsLoading: connectorModel?.phase == .loading,
            selectedConnectors: $selectedConnectors,
            manageConnections: manageConnections,
            skills: skillsAvailable ? skillLibrary?.chooseable : nil,
            skillsLoading: skillLibrary?.isLoading == true,
            skillSlug: $skillSlug,
            manageSkills: manageSkills,
            deepResearch: researchAvailable ? gated($deepResearch, by: .research) : nil,
            // A private turn carries only its words: the private route takes
            // no web search and no local documents, so the rows are absent
            // rather than on and ignored.
            webSearch: voiceActive || isPrivate ? nil : gated($webSearch, by: .webSearch),
            webSearchAvailable: webSearchAvailable,
            memory: voiceActive || memorySettings == nil ? nil : memoryBinding,
            memoryUnavailableReason: isPrivate ? "Incognito" : nil,
            documents: voiceActive || isPrivate || documentIndex == nil ? nil : $documentContext,
            documentCount: indexedDocumentCount
        )
    }

    /// A `+` menu switch whose feature the plan may not include: the row
    /// stays where it is, and turning it on opens the Upgrade sheet on the
    /// plan that does instead (`DesktopPlanGate`).
    private func gated(_ binding: Binding<Bool>, by feature: JunoPlanFeature) -> Binding<Bool> {
        Binding(
            get: { binding.wrappedValue && DesktopPlanGate.shared.allows(feature) },
            set: { isOn in
                if isOn, !DesktopPlanGate.shared.require(feature) { return }
                binding.wrappedValue = isOn
            }
        )
    }

    private var memoryBinding: Binding<Bool> {
        Binding(
            get: { memorySettings?.settings?.memoryEnabled ?? true },
            set: { isOn in
                guard let memorySettings else { return }
                Task { await memorySettings.updateSettings(NativeSettingsPatch(memoryEnabled: isOn)) }
            }
        )
    }

    private var plusMenu: some View {
        Menu {
            ComposerPlusMenu(menu: plusMenuModel)
        } label: {
            JunoIconView(.plus, size: 16)
                .foregroundStyle(Color.junoForeground)
                .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(ComposerControlStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(quota != nil)
        .help("Add files, tools and more")
        .accessibilityLabel(JunoShellPlusMenu.label)
        .accessibilityValue(marks.map(\.label).joined(separator: ", "))
        .accessibilityIdentifier("juno.desktop.chat.add")
    }

    private var modelChip: some View {
        ComposerModelChip(
            selectedModel: selectedModel,
            selectedModelID: selectedModelID,
            catalog: model.modelCatalog,
            catalogError: model.modelCatalogErrorDescription,
            scale: thinkingScale,
            effort: effortBinding,
            fastMode: $fastMode,
            proMode: $proMode,
            choose: { id in
                selectedModelID = id
                // The one place this is set, which is what lets a project's
                // preferred model stop reasserting itself once the reader has
                // said otherwise.
                modelChosenByReader = true
            },
            reload: { Task { await model.reloadModelCatalog() } }
        )
    }

    /// The composer's only microphone (§5.3). The disc beside it starts a
    /// voice *chat*; this one types what you say.
    private var dictateButton: some View {
        Button {
            beginDictation()
        } label: {
            JunoIconView(.mic, size: 16)
                .foregroundStyle(Color.junoForeground)
                .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                .contentShape(.rect)
        }
        .buttonStyle(ComposerControlStyle())
        .disabled(voiceActive || quota != nil)
        .help("Dictate")
        .accessibilityLabel("Dictate")
        .accessibilityIdentifier("juno.desktop.chat-dictate")
    }

    /// The single morphing action (§5.3).
    private var primaryDisc: some View {
        let disc = self.disc
        let face = disc.face
        return ComposerPrimaryDisc(
            face: face,
            label: disc.label,
            help: disc.help
        ) {
            switch face {
            case .stop:
                stopWhatIsRunning()
            // Never waits on a resolved model: a call can start before the
            // catalog lands, on Auto.
            case .voice: startVoice()
            case .send: submit()
            case .busy, .disabled: break
            }
        }
    }

    // MARK: Captions

    private var selectedProjectName: String? {
        guard let projectID = activeProjectID else { return nil }
        return projectModel?.projects.first { $0.id == projectID }?.name
    }

    /// A private reply's failure is not here: the transcript draws it where
    /// the reply would have been, as it does for a saved chat.
    private var errorLine: String? {
        voiceTurnError ?? importError ?? firstTurnError ?? attachmentModel?.lastErrorDescription
    }

    private func caption(_ text: String, icon: JunoIcon, ink: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            JunoIconView(icon, size: 12)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .junoFont(size: 12, relativeTo: .footnote)
        .foregroundStyle(ink)
    }

    /// The quota line (§5.8): what is spent, and the way out. `+` and the disc
    /// are locked beside it.
    private func quotaCaption(_ quota: ChatComposerQuota) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Text(quota.message)
                .foregroundStyle(Color.junoForeground)
            if let openUpgrade {
                Button(action: openUpgrade) {
                    Text(quota.action)
                        .foregroundStyle(Color.junoAccentInk)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.desktop.chat.upgrade")
            }
        }
        .junoFont(size: 12, relativeTo: .footnote)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.chat.quota")
    }

    /// "New chat in {Project}": where a brand-new chat will land (§5.8). A
    /// plain capsule on the canvas, not glass; its ✕ takes the draft back out.
    private func projectCapsule(_ name: String) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(.projects, size: 14)
                .foregroundStyle(Color.junoSecondaryInk)
            Text("New chat in \(Text(name).fontWeight(.medium).foregroundStyle(Color.junoForeground))")
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoSecondaryInk)
                .lineLimit(1)
            Button {
                selectedProjectID = nil
            } label: {
                JunoIconView(.close, size: 12, weight: .bold)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Remove from project")
            .accessibilityLabel("Remove from project")
        }
        .padding(.leading, JunoSpace.close)
        .frame(height: JunoComposerMetrics.controlHeight)
        .background(Capsule().fill(Color.junoCard))
        .overlay(Capsule().strokeBorder(Color.junoBorder, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.chat.new-in-project")
    }

    /// A turn typed during a reply. It leaves when the reply ends; ✕ puts it
    /// back in the field instead.
    private func queuedCaption(_ turn: ChatComposerTurn) -> some View {
        HStack(spacing: JunoSpace.tight) {
            JunoIconView(.clock, size: 12)
            Text("Sends when this reply finishes: \(Text(turn.content).foregroundStyle(Color.junoForeground))")
                .lineLimit(1)
                .truncationMode(.tail)
            Button {
                restore(turn)
            } label: {
                JunoIconView(.close, size: 12, weight: .bold)
                    .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Don't send this yet")
            .accessibilityLabel("Don't send this yet")
        }
        .junoFont(size: 12, relativeTo: .footnote)
        .foregroundStyle(Color.junoSecondaryInk)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.chat.queued")
    }

    // MARK: Long drafts

    /// Between 1,500 characters (or 30 lines) and the collapse: the quiet
    /// offer, never a rule. The web's words.
    private var attachAsFileHint: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("That’s a long one. Attach it as a file to keep the chat tidy?")
                .junoFont(size: 12, relativeTo: .footnote)
                .foregroundStyle(Color.junoSecondaryInk)
            Spacer(minLength: JunoSpace.tight)
            Button(action: attachDraftAsFile) {
                Label("Attach as file", icon: .files, size: 14)
                    .contentShape(.rect)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("juno.desktop.chat.attach-draft")
        }
        .transition(.opacity)
    }

    /// A very large paste as a card standing for the draft (§5.6). The text is
    /// still in `prompt` and Send still sends all of it; what has gone is the
    /// live field that re-measured it on every keystroke.
    private var collapsedDraftCard: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Large paste ready to send")
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                    Text("\(prompt.count.formatted(.number)) characters · full text is kept and will be sent · Enter to send")
                        .junoType(.micro)
                        .foregroundStyle(Color.junoSecondaryInk)
                    Text(prompt.prefix(280) + (prompt.count > 280 ? "…" : ""))
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(3)
                        .padding(.top, JunoSpace.tight)
                }
                Spacer(minLength: 0)
                Button {
                    prompt = ""
                    draftExpanded = false
                } label: {
                    JunoIconView(.close, size: 14)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(width: JunoComposerMetrics.controlHeight, height: JunoComposerMetrics.controlHeight)
                        .contentShape(.rect)
                }
                .buttonStyle(ComposerControlStyle())
                .help("Clear paste")
                .accessibilityLabel("Clear paste")
            }

            HStack(spacing: JunoSpace.snug) {
                Button {
                    draftExpanded = true
                    focused = true
                } label: {
                    Label("Expand to edit", icon: .pencil, size: 14)
                        .contentShape(.rect)
                }
                .accessibilityIdentifier("juno.desktop.chat.expand-draft")

                if canAttachDraft {
                    Button(action: attachDraftAsFile) {
                        Label("Attach as file", icon: .files, size: 14)
                            .contentShape(.rect)
                    }
                    .accessibilityIdentifier("juno.desktop.chat.attach-draft")
                }
                Spacer(minLength: 0)
            }
            .buttonStyle(.bordered)
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JunoRadius.concentric().fill(Color.junoSecondary))
        .focusable()
        .focused($collapsedDraftFocused)
        // Return sends from here too: the card *is* the draft.
        .onKeyPress(.return, phases: .down) { press in
            if press.modifiers.contains(.shift) { return .ignored }
            submit()
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Large paste ready to send. Press Enter to send.")
        .accessibilityIdentifier("juno.desktop.chat.collapsed-draft")
        .onAppear { collapsedDraftFocused = true }
    }

    /// Sends the draft as `prompt.txt` instead of as message text — the web's
    /// `attachAsFile`, same name, same type, same clearing afterwards.
    private func attachDraftAsFile() {
        let content = prompt
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let attachmentModel
        else { return }
        attachmentModel.add(
            data: Data(content.utf8),
            fileName: NativePromptLimits.attachedPromptFileName,
            mimeType: NativePromptLimits.attachedPromptMimeType,
            conversationID: model.selectedConversationID,
            isImage: false
        )
        prompt = ""
        draftExpanded = false
    }

    // MARK: Dictation

    /// The composer's microphone: the field and the controls row cross-fade
    /// into dictation, in the same shell (§5.8).
    private func beginDictation() {
        let session = ComposerDictationSession()
        focused = false
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
            dictation = session
        }
        Task { await session.begin() }
    }

    /// ✕ or Esc: everything heard is dropped, and the draft is as it was.
    private func cancelDictation() {
        dictation?.cancel()
        endDictation()
    }

    /// Done: what was heard goes into the draft, for editing.
    private func stopDictation() {
        guard let dictation else { return }
        appendDictated(dictation.finish())
        endDictation()
    }

    /// The disc, or Return: what was heard is appended and sent at once.
    private func sendDictation() {
        guard let dictation else { return }
        let heard = dictation.finish()
        let sends = !heard.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        appendDictated(heard)
        endDictation()
        guard sends else { return }
        // A turn later, once the field holds the words again: `submit()` reads
        // the draft, and the draft is only whole after this update.
        Task {
            await Task.yield()
            submit()
        }
    }

    private func endDictation() {
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
            dictation = nil
        }
        focused = true
        placeCaretAtEnd()
    }

    private func appendDictated(_ transcript: String) {
        let dictated = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dictated.isEmpty else { return }
        let current = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = current.isEmpty ? dictated : "\(current) \(dictated)"
    }

    // MARK: Selection

    private func consumeDraftProject() {
        guard model.selectedConversationID == nil, let projectID = draftProjectID else { return }
        selectedProjectID = projectID
        draftProjectID = nil
    }

    /// A prompt handed over from elsewhere (Quick Entry, a page's "Ask")
    /// always lands, and is always consumed: it used to wait silently for an
    /// empty field, so a half-typed draft kept it pending until some later
    /// composer turned up empty and it appeared out of nowhere.
    private func consumeDraftPrompt() {
        guard let pending = draftPrompt else { return }
        draftPrompt = nil
        let next = Self.draft(consuming: pending, into: prompt)
        guard next != prompt else { return }
        prompt = next
        focused = true
        placeCaretAtEnd()
    }

    /// What the field holds once a pending prompt arrives. An empty field
    /// takes it as it is; a half-typed draft keeps its words and gains the
    /// new prompt after a blank line, so nothing the reader typed is lost and
    /// nothing handed over is dropped.
    static func draft(consuming pending: String, into current: String) -> String {
        let incoming = pending.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !incoming.isEmpty else { return current }
        let kept = current.trimmingCharacters(in: .whitespacesAndNewlines)
        return kept.isEmpty ? incoming : "\(kept)\n\n\(incoming)"
    }

    /// A starter chip (§4.3): the draft **becomes** the opening — the web's
    /// seed replaces the text rather than appending to it — the field takes
    /// focus, and the caret waits after the opening's trailing space for the
    /// reader's subject. Nothing is sent.
    private func seed(_ opening: String) {
        prompt = opening
        draftExpanded = false
        focused = true
        placeCaretAtEnd()
    }

    /// Puts the caret after the last character.
    ///
    /// Twice: once now, and once after the focus change has landed, because
    /// the field editor that takes focus selects its whole contents as it does
    /// — after this update, not during it.
    private func placeCaretAtEnd() {
        selection = TextSelection(insertionPoint: prompt.endIndex)
        Task { @MainActor in
            await Task.yield()
            selection = TextSelection(insertionPoint: prompt.endIndex)
        }
    }

    /// A draft is filed where it will be created; a saved chat moves.
    private func chooseProject(_ projectID: String?) {
        if fixedProjectID == nil, let conversationID = model.selectedConversationID {
            Task { await model.setProject(id: conversationID, projectID: projectID) }
        } else {
            selectedProjectID = projectID
        }
    }

    private func configureSelection() {
        selectedModelID = DesktopChatSelection.resolvedModelID(
            current: selectedModelID,
            conversationModel: model.selectedConversation?.model ?? "",
            selectable: model.selectableModels
        )
        // A project's preference is written into the chip, not only onto the
        // wire: an assistant configured for Sonnet shows "Sonnet" before Send
        // rather than showing the default and quietly answering as something
        // else. After the resolve, so it outranks the conversation's own stored
        // model, which only records what the last turn used.
        if let preferred = projectPreferredModelID {
            selectedModelID = preferred
        }
        configureThinking()
    }

    private func configureThinking() {
        if selectedModel?.supportsWebSearch != true, selectedModel != nil {
            webSearch = false
        }
        guard let scale = thinkingScale else {
            thinkingStopID = ""
            return
        }
        if scale.stops.contains(where: { $0.id == thinkingStopID }) { return }
        thinkingStopID = scale.defaultStop?.id ?? ""
    }

    // MARK: Sending

    /// Return, or the disc's Send face.
    private func submit() {
        guard !draftIsEmpty else { return }
        // A live call takes the turn before the chat route sees it — otherwise
        // the draft became a written exchange the spoken one knew nothing about.
        if let voiceCall {
            sendVoiceTurn(voiceCall)
            return
        }
        // Steer mode: the words go to the run, not to a new reply.
        if inSteerMode, let steering {
            steer(through: steering)
            return
        }
        // A typed `/slug …` naming one of the reader's skills arms it and sends
        // the words after it (the web's `readSkillInvocation`): the route takes
        // `skillSlug` and never reads a leading slash, so `/usr/local` stays a
        // sentence. A bare `/slug` only arms it, as picking it from the menu does.
        if skillsAvailable, let typed = skillLibrary?.invocation(in: prompt) {
            skillSlug = typed.choice.slug
            prompt = typed.remainder
            if typed.remainder.isEmpty {
                draftExpanded = false
                return
            }
        }
        guard canSubmit else { return }
        let turn = composeTurn()
        seedTranscriptImages(for: turn)
        if isGenerating {
            // Exactly one waits. A second is refused, and its words stay put —
            // nothing is overwritten in silence.
            guard queuedTurn == nil else { return }
            queuedTurn = turn
            clearDraft()
            return
        }
        dispatch(turn, restoreOnRefusal: false)
    }

    /// Sends the field's words to the run and clears them only when the
    /// server took them. Text only: attachments stay in the tray for the next
    /// ordinary message, as the web's composer leaves them.
    private func steer(through steering: ChatComposerSteering) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSteeringInFlight else { return }
        isSteeringInFlight = true
        let sent = prompt
        Task {
            let accepted = await steering.steer(text)
            isSteeringInFlight = false
            // Only the words that went: anything typed meanwhile stays.
            if accepted, prompt == sent {
                prompt = ""
                draftExpanded = false
            }
        }
    }

    private func composeTurn() -> ChatComposerTurn {
        ChatComposerTurn(
            content: prompt,
            conversationID: fixedProjectID == nil ? model.selectedConversationID : nil,
            projectID: fixedProjectID ?? selectedProjectID,
            // The project's preference, unless the reader has spoken; then
            // whatever the chip shows. Nothing overrules a model the reader
            // picked for this conversation.
            modelID: projectPreferredModelID ?? selectedModelID,
            effort: reasoningEffort,
            attachmentIDs: attachmentModel?.uploadedIDs ?? [],
            attachments: attachmentModel?.messageAttachments ?? [],
            deepResearch: deepResearch && researchAvailable,
            webSearch: webSearch && webSearchAvailable,
            connectors: isPrivate ? [] : Array(selectedConnectors.prefix(ComposerPlusMenuModel.connectorLimit)),
            fastMode: fastMode,
            proMode: proMode,
            groundDocuments: documentGroundingArmed,
            documentCount: indexedDocumentCount,
            skillSlug: armedSkill?.slug,
            contextTokens: contextTokens.filter { prompt.contains("@" + $0.label) }
        )
    }

    /// Hands the transcript the bytes of every picture in a turn, before the
    /// draft is cleared and the bytes go with it.
    private func seedTranscriptImages(for turn: ChatComposerTurn) {
        guard let transcriptMedia, let attachmentModel else { return }
        for attachment in turn.attachments where attachment.isImageKind {
            if let data = attachmentModel.localImageData(forUploadedID: attachment.id) {
                transcriptMedia.seed(data, for: attachment.id)
            }
        }
    }

    /// Clears what a turn took with it. Research is per-send, on purpose:
    /// "I meant this one to be research" must not become "every message is".
    private func clearDraft() {
        prompt = ""
        draftExpanded = false
        attachmentModel?.clear()
        deepResearch = false
        skillSlug = nil
        contextTokens = []
    }

    /// Puts a queued turn's words back in the field.
    private func restore(_ turn: ChatComposerTurn) {
        contextTokens = turn.contextTokens
        if queuedTurn?.content == turn.content { queuedTurn = nil }
        if prompt.isEmpty { prompt = turn.content }
        focused = true
    }

    /// The Stop face's action, and Chat › Stop Generating's (⌘.): one function,
    /// so the menu stops exactly what the disc would. In steer mode the run's
    /// own Stop, which ends whichever of the reply and the run the reader is
    /// watching; otherwise the reply.
    private func stopWhatIsRunning() {
        switch ChatCommands.stopTarget(isGenerating: isGenerating, inSteerMode: inSteerMode) {
        case .run: steering?.stop()
        case .reply: stopGeneration()
        case nil: break
        }
    }

    /// ⌘. from the menu bar, while there is something to stop. The draft does
    /// not take it away: typing a correction turns the disc to Send, and the
    /// reader may still want the run stopped.
    private var stopCommand: ChatComposerStopCommand? {
        guard ChatCommands.stopTarget(isGenerating: isGenerating, inSteerMode: inSteerMode) != nil
        else { return nil }
        return ChatComposerStopCommand { stopWhatIsRunning() }
    }

    /// Stops the reply in flight — the store's, or the private chat's.
    private func stopGeneration() {
        if let privateChat {
            privateChat.stopGeneration()
        } else {
            model.stopGeneration()
        }
    }

    /// The disc's voice face: a spoken conversation, on whatever the chip
    /// shows — Auto before the catalog lands.
    private func startVoice() {
        guard DesktopPlanGate.shared.require(.voice) else { return }
        openVoiceMode(selectedModelID)
    }

    /// Sends a composed turn.
    ///
    /// A new chat's first turn is also the handoff (§10.1): the empty state
    /// hears ``ChatFirstTurnEvent/began(_:)`` inside the handoff's transaction
    /// the moment Return is pressed, so the composer settles to its dock while
    /// the store is still creating the conversation — and hears
    /// ``ChatFirstTurnEvent/refused`` if the store then says no, so the draft
    /// comes back to the middle with its words still in the field.
    ///
    /// - Parameter restoreOnRefusal: a queued turn has already left the field;
    ///   if the store refuses it, its words go back rather than vanishing.
    private func dispatch(_ turn: ChatComposerTurn, restoreOnRefusal: Bool) {
        if let privateChat {
            dispatchPrivate(turn, to: privateChat)
            return
        }
        let startsChat = turn.conversationID == nil && fixedProjectID == nil && onFirstTurn != nil
        firstTurnError = nil
        if startsChat {
            withAnimation(JunoMotion.handoff(reduceMotion: reduceMotion)) {
                onFirstTurn?(.began(turn.content, attachments: turn.attachments))
            }
        }
        isDispatching = true
        // Whatever the last send said about documents is now history.
        groundingNote = nil
        Task {
            defer { isDispatching = false }
            // Grounding happens before anything is created or appended: the
            // turn's text has to be final by then, because `sendMessage` sends
            // the string it is given and there is no second channel.
            let grounding = await groundedTurn(for: turn.content, armed: turn.groundDocuments)

            let conversationID: String?
            if let existing = turn.conversationID {
                conversationID = existing
            } else {
                model.isDraftingNewConversation = true
                conversationID = await model.createConversationResolvingID(
                    model: turn.modelID,
                    projectID: turn.projectID
                )
            }
            guard let conversationID else {
                if restoreOnRefusal { restore(turn) }
                if startsChat { handBack() }
                return
            }
            let sent = model.sendMessage(
                conversationID: conversationID,
                prompt: grounding.promptForModel,
                modelID: turn.modelID,
                reasoningEffort: turn.effort,
                attachmentIDs: turn.attachmentIDs,
                deepResearch: turn.deepResearch,
                webSearch: turn.webSearch,
                connectors: turn.connectors,
                fastMode: turn.fastMode,
                proMode: turn.proMode,
                attachments: turn.attachments,
                skillSlug: turn.skillSlug,
                contextTokens: turn.contextTokens
            )
            guard sent else {
                if restoreOnRefusal { restore(turn) }
                if startsChat { handBack() }
                return
            }
            if startsChat { onFirstTurn?(.accepted) }
            // A direct send clears only now, once accepted — and only the words
            // that were sent: anything typed during the round trip stays.
            if !restoreOnRefusal {
                if prompt == turn.content { prompt = "" }
                draftExpanded = false
                attachmentModel?.clear()
                deepResearch = false
                if skillSlug == turn.skillSlug { skillSlug = nil }
            }
            // Written only after the turn was accepted, and only when grounding
            // was armed: a note about documents beside a message that never left
            // is news about something that did not happen.
            if turn.groundDocuments {
                groundingNote = Self.groundingNote(for: grounding, documentCount: turn.documentCount)
            }
            Task { await model.generateTitleIfNeeded(conversationID: conversationID) }
            didSendConversation?(conversationID)
        }
    }

    /// The store refused a new chat's first turn: the handoff runs backwards,
    /// in the same transaction shape, and the words are still in the field.
    private func handBack() {
        firstTurnError = model.chatErrorDescription ?? model.lastErrorDescription
            ?? "Juno couldn't start this chat. Your message is still here — try again."
        withAnimation(JunoMotion.handoff(reduceMotion: reduceMotion)) {
            onFirstTurn?(.refused)
        }
    }

    /// Sends a turn to the private chat (§5.8, Private).
    ///
    /// Synchronous: the private model appends the reader's turn and the reply's
    /// placeholder at once and streams into it, so the first send is the handoff
    /// itself — run inside the handoff's transaction, the draft ends in the same
    /// update the turns arrive in. Only the words and the model settings go:
    /// the private route takes no files, no tools and no project.
    private func dispatchPrivate(_ turn: ChatComposerTurn, to privateChat: NativePrivateChatModel) {
        let before = privateChat.turns.count
        let send = {
            privateChat.send(
                prompt: turn.content,
                modelID: turn.modelID,
                reasoningEffort: turn.effort,
                fastMode: turn.fastMode,
                proMode: turn.proMode
            )
        }
        if before == 0 {
            withAnimation(JunoMotion.handoff(reduceMotion: reduceMotion), send)
        } else {
            send()
        }
        // Cleared only if the model took the turn: a send it refused leaves
        // the words where they were, as the store's path does.
        guard privateChat.turns.count > before else { return }
        if prompt == turn.content { prompt = "" }
        draftExpanded = false
    }

    /// This Mac's passages for one turn, folded into its text — or the reader's
    /// own words untouched when grounding is off, there is no index, or nothing
    /// matched. ``NativeDocumentGrounding`` alone decides what a grounded turn is.
    ///
    /// - Parameter armed: the snapshot in the turn, not the live switch, so a
    ///   toggle flipped mid-flight cannot make the note disagree with the send.
    private func groundedTurn(for content: String, armed: Bool) async -> NativeDocumentGrounding {
        guard armed, let documentIndex else {
            return NativeDocumentGrounding(ungrounded: content)
        }
        let passages = await documentIndex.passages(
            matching: content,
            limit: NativeDocumentGrounding.maximumPassages
        )
        return NativeDocumentGrounding.ground(prompt: content, in: passages)
    }

    /// What the composer says about a send that has just happened: the two
    /// outcomes worded so they cannot be confused, because one means the
    /// reader's files left the Mac inside a message and the other that they
    /// were searched and had nothing to say.
    static func groundingNote(for grounding: NativeDocumentGrounding, documentCount: Int) -> String {
        guard grounding.isGrounded else {
            return documentCount == 1
                ? "Nothing in your 1 indexed document matched that question, so none of it was attached."
                : "Nothing in your \(documentCount) indexed documents matched that question, so none of it was attached."
        }
        let excerpts = grounding.cited.count == 1 ? "1 excerpt" : "\(grounding.cited.count) excerpts"
        return "Sent \(excerpts) from \(grounding.citedSourceNames.joined(separator: ", ")) — they are in your message above."
    }

    // MARK: Voice turns

    /// Sends the draft — text and up to four images — through the live call
    /// rather than the chat route, so the model answers it out loud in context.
    ///
    /// The encoding, the ceiling and the socket re-check live in
    /// ``JunoRealtimeVoiceController/sendTurn(text:images:)``, which the phone
    /// calls too; this only decides whether there is a turn worth handing over.
    private func sendVoiceTurn(_ call: DesktopVoiceColumn) {
        guard !isSendingVoiceTurn else { return }
        voiceTurnError = nil
        let controller = call.controller
        guard controller.phase == .live else {
            voiceTurnError = switch controller.phase {
            case .ended, .error:
                "This voice session has ended. Restart it, or hang up to keep typing."
            default:
                "Voice is still connecting. Try again in a moment."
            }
            return
        }

        let staged = attachmentModel?.attachments ?? []
        guard staged.count <= Self.maximumVoiceImages else {
            voiceTurnError = "Voice mode accepts up to 4 images in one turn."
            return
        }
        // `previewData` is the payload the upload model already holds for an
        // image; an attachment without one cannot be shown over this socket,
        // so the turn is refused rather than quietly sent without it.
        let images = staged.compactMap { attachment in
            attachment.previewData.map {
                JunoVoiceTurnImage(jpeg: $0, attachmentID: attachment.uploadedID)
            }
        }
        guard images.count == staged.count else {
            voiceTurnError = "Voice mode can send images only — remove the other attachments first."
            return
        }
        guard images.isEmpty || voiceCanSeeImages else {
            voiceTurnError = Self.noVisionMessage
            return
        }

        let text = prompt
        isSendingVoiceTurn = true
        Task {
            let accepted = await controller.sendTurn(text: text, images: images)
            isSendingVoiceTurn = false
            guard accepted else {
                voiceTurnError = images.isEmpty ? "Voice could not send that turn." : Self.noVisionMessage
                return
            }
            prompt = ""
            draftExpanded = false
            attachmentModel?.clear()
        }
    }

    /// The web's words for a provider with no eyes, naming the same three
    /// alternatives on both clients.
    private static let noVisionMessage =
        "This voice model can’t see images. Switch to OpenAI, Gemini or Qwen."

    // MARK: Attaching

    /// ⇧⌘U from the `+` menu: the system picker chooses the window or display,
    /// and the frame lands here as a picture.
    private func takeScreenshot() {
        guard let attachmentModel else { return }
        let conversationID = model.selectedConversationID
        DesktopScreenshotCapture.shared.capture(
            completion: { data in
                attachmentModel.add(
                    data: data,
                    fileName: "Screenshot \(Int(Date().timeIntervalSince1970)).png",
                    mimeType: "image/png",
                    conversationID: conversationID,
                    isImage: true
                )
            },
            failure: { message in importError = message }
        )
    }

    /// Hands the paste monitor a handler over this render's inputs. The
    /// monitor runs outside any body evaluation, so a handler captured once
    /// would keep reading the quota, the call and the private mode it was
    /// installed with; it is re-armed whenever any of the three changes.
    private func armPasteMonitor() {
        pasteMonitor.attach = { focused && attachFromPasteboard() }
    }

    /// A paste of files or a picture. False when the pasteboard holds neither,
    /// so the key goes on to the field and pastes text as usual.
    private func attachFromPasteboard() -> Bool {
        guard canAttach, let attachmentModel else { return false }
        let found = ChatComposerPasteMonitor.pasteboardAttachments()
        if !found.urls.isEmpty {
            attach(found.urls, securityScoped: false)
            return true
        }
        if let image = found.image {
            guard isInCall == false || voiceCanSeeImages else { return false }
            attachmentModel.add(
                data: image,
                fileName: "Pasted image \(Int(Date().timeIntervalSince1970)).png",
                mimeType: "image/png",
                conversationID: model.selectedConversationID,
                isImage: true
            )
            return true
        }
        return false
    }

    /// Files from the importer, a drop or a paste.
    ///
    /// - Parameter securityScoped: the importer's URLs need their scope opened;
    ///   a drop's and a paste's arrive already readable.
    private func attach(_ urls: [URL], securityScoped: Bool) {
        guard let attachmentModel else { return }
        importError = nil
        guard canAttach else {
            if isPrivate {
                // The server's own words (`private_attachments_unsupported`).
                importError = "Attachments are not available in private chat."
            } else if quota == nil {
                importError = voiceActive
                    ? "This voice model can’t see images. Switch to OpenAI, Gemini or Qwen."
                    : "You can attach up to \(NativeComposerAttachmentModel.maximumAttachments) files to one message."
            }
            return
        }
        // A call's ceiling is the relay's four, not the message route's ten.
        let ceiling = voiceActive
            ? Self.maximumVoiceImages
            : NativeComposerAttachmentModel.maximumAttachments
        let room = max(0, ceiling - attachmentModel.attachments.count)
        for url in urls.filter(\.isFileURL).prefix(room) {
            let granted = securityScoped && url.startAccessingSecurityScopedResource()
            defer { if granted { url.stopAccessingSecurityScopedResource() } }
            do {
                let contentType = try url.resourceValues(forKeys: [.contentTypeKey]).contentType
                let isImage = contentType?.conforms(to: .image) == true
                if voiceActive, !isImage {
                    importError = "Voice mode can send images only — remove the other attachments first."
                    continue
                }
                let data = try Data(contentsOf: url)
                attachmentModel.add(
                    data: data,
                    fileName: url.lastPathComponent,
                    mimeType: contentType?.preferredMIMEType ?? "application/octet-stream",
                    conversationID: model.selectedConversationID,
                    isImage: isImage
                )
            } catch {
                importError = "Could not attach \(url.lastPathComponent): \(error.localizedDescription)"
            }
        }
    }
}

// MARK: - Pending steers

/// The instructions a running task has not read yet, above the field (the
/// web's `PendingSteers`). Opaque, inside the shell's above-slot: a
/// `junoSecondary` tile at the field rung. No ✕: a queued steer is a committed
/// row in the task's log, and there is nothing to withdraw it with — another
/// instruction, after it, is how one is corrected.
///
/// The steering composer's signature: the strip rises in the moment the
/// server takes a steer and leaves when the run reads it. Both are announced,
/// because neither comes with a control to notice it by.
struct ComposerPendingSteers: View {
    let steers: [ChatPendingSteer]
    /// A pinned "now" for fixtures; nil reads the clock each minute.
    var now: Date? = nil

    private var header: String {
        steers.count == 1
            ? "Queued \u{2014} Juno reads this before its next step"
            : "Queued \u{2014} Juno reads these \(steers.count) before its next step, in order"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(header)
                .junoFont(size: 11, relativeTo: .caption, weight: .medium)
                .foregroundStyle(Color.junoSecondaryInk)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                ForEach(steers) { steer in
                    row(steer)
                }
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.close)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoSecondary, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.desktop.chat.pending-steers")
        .onChange(of: steers.count) { previous, count in
            if count > previous {
                AccessibilityNotification.Announcement("Added to the task. \(header).").post()
            }
        }
    }

    private func row(_ steer: ChatPendingSteer) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(.cornerDownRight, size: 12)
                .foregroundStyle(Color.junoSecondaryInk)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                .accessibilityHidden(true)
            Text(steer.text)
                .junoFont(size: 13, relativeTo: .callout)
                .foregroundStyle(Color.junoForeground)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if let now {
                    Text(ChatWorkFormat.ago(steer.at, now: now))
                } else {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(ChatWorkFormat.ago(steer.at, now: context.date))
                    }
                }
            }
            .junoFont(size: 11, relativeTo: .caption)
            .foregroundStyle(Color.junoSecondaryInk)
            .monospacedDigit()
            .fixedSize()
        }
        .accessibilityElement(children: .combine)
    }
}

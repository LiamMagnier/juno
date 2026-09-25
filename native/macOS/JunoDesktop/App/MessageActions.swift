import AVFoundation
import AppKit
import Combine
import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

// MARK: - What a turn can do

/// How a reply is asked again — the Regenerate menu's four entries.
enum MessageRegenerateRequest: Equatable {
    /// Try Again: the same question, the same model.
    case again
    /// Switch Model ▸: the same question of another model.
    case model(String)
    /// More Concise and Add Details: the same question with a one-shot
    /// instruction, sent verbatim as `regenerateInstruction`.
    case instruction(String)

    /// The web's strings (`message-item.tsx`, `RegenerateMenu`), verbatim.
    static let moreConcise = "Make the answer more concise: keep the substance, cut the length by at least half."
    static let addDetails = "Add more detail: expand the answer with the specifics, examples and caveats that were left out."
}

/// Everything a turn's actions reach, as closures the transcript supplies. A
/// nil closure is an action this turn does not have — the row asks
/// ``MessageMenuModel`` what to draw from which ones are present.
struct MessageRowActions {
    /// Copy, Quote in Composer and Read Aloud take the words **shown** — the
    /// raw Markdown of the version on screen, which is the live row's unless
    /// the reader has paged back to an earlier one.
    var copy: ((String) -> Void)? = nil
    var setFeedback: ((NativeChatFeedback?) -> Void)? = nil
    var regenerate: ((MessageRegenerateRequest) -> Void)? = nil
    var readAloud: ((String) -> Void)? = nil
    var stopReading: (() -> Void)? = nil
    /// Branch ▸ Into a New Saved Chat: `POST /api/conversations/{id}/fork`.
    var branch: (() -> Void)? = nil
    /// Branch ▸ Fork Privately, and the reader's turn's own Fork Privately.
    var forkPrivately: (() -> Void)? = nil
    /// Share Chat…, which opens the window's Share popover.
    var share: (() -> Void)? = nil
    var quote: ((String) -> Void)? = nil
    var copyLink: (() -> Void)? = nil
    /// Continue, from the finish note of a reply that stopped part-way.
    var continueResponse: (() -> Void)? = nil
    /// Try Again, from the error box of the newest reply that failed.
    var retry: (() -> Void)? = nil
    /// Opens the Activity panel on this reply's run, on a call when one is
    /// given.
    var openActivity: ((String?) -> Void)? = nil
    /// Opens the Research panel on a run, by id — `message:<id>` for a
    /// research turn a profile-1 server answers inside the chat.
    var openResearch: ((String) -> Void)? = nil
    /// "Research this", the chip `suggest_research` puts under an answer:
    /// sends its question as a Research request.
    var researchThis: ((String) -> Void)? = nil
    /// Retry Send, under a question that never reached the server.
    var retrySend: (() -> Void)? = nil
    var stepBranch: ((Int) -> Void)? = nil
    /// The earlier versions of this message, oldest first
    /// (`GET /api/messages/{id}/versions`), for its version pager. Nil on a
    /// turn with no row on the server.
    var loadVersions: (() async throws -> [NativeMessageVersion])? = nil
    /// Says that something asked of this turn failed — in the window's toast
    /// host (§7.7).
    var reportFailure: ((String) -> Void)? = nil
    /// Re-asks this question with new wording, as a new branch. Nil on answers
    /// and on turns with no row on the server.
    var editMessage: ((String) -> Void)? = nil
    var openArtifact: (NativeMessageContent.ArtifactReference, NativeChatMessage) -> Void = { _, _ in }
}

// MARK: - The menu model

/// Which actions a reply shows, and what its two menus hold — pure, so the
/// rules can be tested without drawing a menu (menus and tooltips cannot be
/// rendered offscreen).
///
/// The web's rules, from `message-item.tsx`: five at rest — Copy · Good · Bad ·
/// Regenerate ▾ · More ▾ — which is the Claude / ChatGPT count. Read Aloud,
/// Branch, Share, Quote and Copy Link live one level down in More, with the
/// model, tokens and cost that used to print under every answer.
struct MessageMenuModel: Equatable {
    enum RowAction: Hashable {
        case copy, goodResponse, badResponse, regenerate, more
    }

    enum RegenerateItem: Equatable {
        case tryAgain, switchModel, divider, moreConcise, addDetails
    }

    enum BranchItem: Equatable {
        case intoNewChat, forkPrivately
    }

    enum MoreItem: Equatable {
        case readAloud
        case stopReading
        case branch([BranchItem])
        case shareChat
        case divider
        case quote
        case copyLink
        /// The receipt: the model's name and the mono token/cost line.
        case info(model: String?, meta: String?)
    }

    struct Input: Equatable {
        /// The answer has words — not only a picture or a file.
        var hasText = true
        /// No words, and at least one attachment: an image-only reply.
        var isMediaOnly = false
        /// The newest reply in the transcript.
        var isNewest = false
        var isGenerating = false
        /// A private chat's turn: nothing on the server to rate, re-ask,
        /// branch, share or link to.
        var isPrivate = false
        /// The turn has a row in a saved conversation on the server.
        var isSaved = true
        var canRate = true
        var canRegenerate = true
        var canReadAloud = true
        var isSpeaking = false
        var canBranch = true
        var canForkPrivately = true
        var canShare = true
        var canQuote = true
        var modelName: String? = nil
        var meta: String? = nil
    }

    let row: [RowAction]
    let regenerate: [RegenerateItem]
    let more: [MoreItem]

    init(_ input: Input) {
        let busy = input.isGenerating
        let readAloud = input.canReadAloud && input.hasText
        let branchSaved = input.canBranch && input.isSaved && !busy && !input.isPrivate
        let forkPrivately = input.canForkPrivately && !busy && !input.isPrivate
        let share = input.canShare && input.isSaved && !input.isPrivate
        let quote = input.canQuote && input.hasText
        let copyLink = input.isSaved && !input.isPrivate
        let hasMeta = input.modelName != nil || input.meta != nil

        var more: [MoreItem] = []
        if readAloud { more.append(input.isSpeaking ? .stopReading : .readAloud) }
        var branch: [BranchItem] = []
        if branchSaved { branch.append(.intoNewChat) }
        if forkPrivately { branch.append(.forkPrivately) }
        if !branch.isEmpty { more.append(.branch(branch)) }
        if share { more.append(.shareChat) }
        // Only when both neighbouring groups have something in them.
        if (quote || copyLink) && !more.isEmpty { more.append(.divider) }
        if quote { more.append(.quote) }
        if copyLink { more.append(.copyLink) }
        if hasMeta {
            if !more.isEmpty { more.append(.divider) }
            more.append(.info(model: input.modelName, meta: input.meta))
        }
        self.more = more

        var row: [RowAction] = []
        if input.hasText { row.append(.copy) }
        if input.canRate && !input.isPrivate {
            row.append(.goodResponse)
            row.append(.badResponse)
        }
        let regenerates = input.canRegenerate && input.isNewest && !busy
            && !input.isPrivate && !input.isMediaOnly
        if regenerates { row.append(.regenerate) }
        if !more.isEmpty { row.append(.more) }
        self.row = row

        regenerate = regenerates ? [.tryAgain, .switchModel, .divider, .moreConcise, .addDetails] : []
    }
}

// MARK: - The button

/// One message action: a 28pt circle, a 16pt glyph, no container, no glass
/// and no tint — the web's `Pressable kind="icon"` (§3.2 of the Phase 2 brief).
///
/// - `isOn` (a rated thumb): the accent ink on the `--selected` ground, held
///   under the pointer, so the state reads in a fill as well as in the glyph's
///   solid cut.
/// - `isOpen` (a menu that is showing): the card's fill with a hairline.
/// - Hover: the neutral `--accent` circle and the foreground ink.
/// - Rest: secondary ink on nothing at all.
///
/// Pure SwiftUI: it sits under the detail column's accent tint (§0.4), and a
/// system button style here is what lit the whole row coral.
struct MessageActionButtonStyle: ButtonStyle {
    var isOn = false
    var isOpen = false
    /// 28 for the actions, 24 for the version pager's arrows.
    var diameter: CGFloat = 28

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, isOn: isOn, isOpen: isOpen, diameter: diameter)
    }

    private struct Face: View {
        let configuration: ButtonStyleConfiguration
        let isOn: Bool
        let isOpen: Bool
        let diameter: CGFloat

        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.isFocused) private var isFocused
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        private var lit: Bool { hovered && isEnabled }

        private var ink: Color {
            if isOn { return .junoAccentInk }
            if lit || isOpen { return .junoForeground }
            return .junoSecondaryInk
        }

        var body: some View {
            configuration.label
                .foregroundStyle(ink)
                .frame(width: diameter, height: diameter)
                .background { ground }
                .overlay {
                    // The graphite ring, 2pt, standing 2pt off the circle — the
                    // system's own focus ring is turned off at the call site.
                    Circle()
                        .stroke(Color.junoRing, lineWidth: 2)
                        .padding(-2)
                        .opacity(isFocused ? 1 : 0)
                }
                .contentShape(Circle())
                .opacity(isEnabled ? 1 : 0.5)
                .allowsHitTesting(isEnabled)
                .scaleEffect(
                    configuration.isPressed ? JunoMotion.scaleFrom(0.97, reduceMotion: reduceMotion) : 1
                )
                .onHover { hovered = $0 }
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: lit)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: isOpen)
                .animation(JunoMotion.reduced(JunoMotion.press, when: reduceMotion), value: configuration.isPressed)
                .preference(key: MessageActionFocusKey.self, value: isFocused)
        }

        @ViewBuilder
        private var ground: some View {
            if isOn {
                Circle().fill(Color.junoSelected)
            } else if isOpen {
                Circle()
                    .fill(Color.junoCard)
                    .overlay(Circle().strokeBorder(Color.junoBorder, lineWidth: 1))
            } else {
                Circle()
                    .fill(Color.junoHover)
                    .opacity(lit ? 1 : 0)
            }
        }
    }
}

/// Whether any action in a row holds keyboard focus — reported up from the
/// button style, which is the only place `isFocused` describes the button.
struct MessageActionFocusKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/// The feedback swell: 0.86 → 1.18 → 1 on the out-back curve, over
/// `--dur-base`. A modifier of its own, so the keyframe closure captures no
/// generic glyph type.
struct MessageFeedbackSwell: ViewModifier {
    let trigger: Int

    func body(content: Content) -> some View {
        content
            .keyframeAnimator(initialValue: CGFloat(1), trigger: trigger) { view, scale in
                view.scaleEffect(scale)
            } keyframes: { _ in
                KeyframeTrack {
                    MoveKeyframe(CGFloat(0.86))
                    LinearKeyframe(
                        CGFloat(1.18),
                        duration: JunoMotion.Duration.base / 2,
                        timingCurve: JunoMotion.swellCurve
                    )
                    LinearKeyframe(
                        CGFloat(1),
                        duration: JunoMotion.Duration.base / 2,
                        timingCurve: JunoMotion.swellCurve
                    )
                }
            }
    }
}

/// A plain message action: the button, its tooltip, its label for VoiceOver,
/// and — for a thumb — the swell and burst that are its only receipt.
struct MessageActionButton<Glyph: View>: View {
    let label: String
    var isOn = false
    /// Swell and burst when this turns on (the web's `celebrate`). Only the
    /// feedback thumbs: everything else in the row has a receipt of its own.
    var celebrates = false
    let action: () -> Void
    @ViewBuilder let glyph: () -> Glyph

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var swells = 0

    var body: some View {
        Button(action: action) {
            glyph()
                .modifier(MessageFeedbackSwell(trigger: swells))
                .overlay { MessageFeedbackBurst(trigger: swells) }
        }
        .buttonStyle(MessageActionButtonStyle(isOn: isOn))
        .contentShape(Circle())
        .focusEffectDisabled()
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .onChange(of: isOn) { wasOn, nowOn in
            // Only a thumb turning ON celebrates, and never under Reduce Motion.
            guard celebrates, nowOn, !wasOn, !reduceMotion else { return }
            swells += 1
        }
    }
}

extension MessageActionButton where Glyph == JunoIconView {
    init(
        _ label: String,
        icon: JunoIcon,
        isOn: Bool = false,
        celebrates: Bool = false,
        action: @escaping () -> Void
    ) {
        self.init(label: label, isOn: isOn, celebrates: celebrates, action: action) {
            JunoIconView(icon, size: 16, isOn: isOn)
        }
    }
}

/// Six particles leaving a thumb once as it turns on — the web's `Burst`
/// (`components/ui/micro.tsx`): 4pt dots at 15° + 60°·n, each fading from 0.9
/// to nothing and shrinking from 0.4 to 0.2 as it travels 3.6pt (0.9 of its own
/// width) on `--ease-out-expo` over `--dur-slow`.
private struct MessageFeedbackBurst: View {
    let trigger: Int

    var body: some View {
        // At rest the progress is 1 — every particle already gone — so nothing
        // is drawn until a trigger runs it from 0 again.
        Color.clear
            .keyframeAnimator(initialValue: CGFloat(1), trigger: trigger) { content, progress in
                content.overlay {
                    ZStack {
                        ForEach(0..<6, id: \.self) { index in
                            let angle = Angle.degrees(15 + 60 * Double(index))
                            Circle()
                                .fill(Color.junoAccentInk)
                                .frame(width: 4, height: 4)
                                .scaleEffect(0.4 + (0.2 - 0.4) * progress)
                                .opacity(0.9 * (1 - progress))
                                .offset(
                                    x: cos(angle.radians) * 3.6 * progress,
                                    y: sin(angle.radians) * 3.6 * progress
                                )
                        }
                    }
                }
            } keyframes: { _ in
                KeyframeTrack {
                    MoveKeyframe(CGFloat(0))
                    LinearKeyframe(
                        CGFloat(1),
                        duration: JunoMotion.Duration.slow,
                        timingCurve: JunoMotion.burstCurve
                    )
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// Copy ⇄ check in one box — the web's `IconSwap curve="spring"`. A manual
/// cross-fade, because ``JunoIconView`` is a drawn image and not a symbol that
/// `.symbolEffect(.replace)` could morph: both faces share the cell, the
/// arriving one settling on `--ease-spring`, the leaving one accelerating away
/// on `--ease-in`, each 0.8 ↔ 1 in scale over `--dur-fast`.
struct MessageCopyGlyph: View {
    let copied: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            JunoIconView(.copy, size: 16)
                .opacity(copied ? 0 : 1)
                .scaleEffect(copied ? JunoMotion.scaleFrom(0.8, reduceMotion: reduceMotion) : 1)
                .animation(
                    JunoMotion.reduced(
                        copied ? JunoMotion.swapLeave : JunoMotion.swapArrive,
                        when: reduceMotion,
                        tier: .tint
                    ),
                    value: copied
                )
            JunoIconView(.check, size: 16)
                .foregroundStyle(Color.junoSuccessInk)
                .opacity(copied ? 1 : 0)
                .scaleEffect(copied ? 1 : JunoMotion.scaleFrom(0.8, reduceMotion: reduceMotion))
                .animation(
                    JunoMotion.reduced(
                        copied ? JunoMotion.swapArrive : JunoMotion.swapLeave,
                        when: reduceMotion,
                        tier: .tint
                    ),
                    value: copied
                )
        }
        .frame(width: 16, height: 16)
    }
}

// MARK: - The row

/// Which menu trigger a row's pointer is over, and so which one a menu that
/// opens now belongs to.
enum MessageMenuTrigger: Equatable {
    case regenerate, more
}

/// A turn's actions: the version pager, then the cluster that fades.
///
/// The cluster is always at full strength on the newest reply — everything a
/// reader does with an answer they do to the one that just arrived, and a
/// control that waits for the pointer is not discoverable on a first visit.
/// Anywhere else it waits for the turn's hover, a focused action, a menu it
/// opened, or a copy it is confirming.
///
/// SwiftUI's `Menu` does not say when it opens, and the pointer leaves the row
/// for the menu the moment it does — so an older reply's More would fade out
/// from under its own menu. The row listens for AppKit's menu tracking
/// instead, and claims a menu that begins while the pointer is over one of its
/// own triggers.
struct MessageActionRow<Pager: View, Cluster: View>: View {
    /// Keep the cluster visible with the pointer elsewhere: the newest reply.
    var alwaysVisible = false
    /// The pointer is over the turn: the web's `group-hover`.
    let turnHovered: Bool
    /// A copy is being confirmed, which keeps the check in view.
    var copied = false
    /// Written by the row, read by the menu triggers for their open look.
    @Binding var openTrigger: MessageMenuTrigger?
    /// Written by the triggers' `onHover`.
    let hoveredTrigger: MessageMenuTrigger?
    @ViewBuilder let pager: () -> Pager
    @ViewBuilder let cluster: () -> Cluster

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoSnapshotHover) private var snapshotHover
    @State private var focusWithin = false
    @State private var menuTracking = false

    private var shown: Bool {
        alwaysVisible || turnHovered || focusWithin || menuTracking || copied || snapshotHover
    }

    var body: some View {
        HStack(spacing: 0) {
            pager()
            HStack(spacing: 0) { cluster() }
                .opacity(shown ? 1 : 0)
                .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: shown)
                .onPreferenceChange(MessageActionFocusKey.self) { focusWithin = $0 }
        }
        .frame(height: 32)
        .onReceive(NotificationCenter.default.publisher(for: NSMenu.didBeginTrackingNotification)) { _ in
            guard let hoveredTrigger else { return }
            menuTracking = true
            openTrigger = hoveredTrigger
        }
        .onReceive(NotificationCenter.default.publisher(for: NSMenu.didEndTrackingNotification)) { _ in
            guard menuTracking else { return }
            menuTracking = false
            openTrigger = nil
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Menus

/// Regenerate ▾ — Try Again · Switch Model ▸ · More Concise · Add Details.
///
/// The trigger is the refresh glyph with the set's smallest caret beside it,
/// inside the same 28pt circle, to say the press opens a menu rather than
/// acting. Menu labels are Title Case (§0.7); the instructions go to the server
/// verbatim.
struct MessageRegenerateMenu: View {
    let items: [MessageMenuModel.RegenerateItem]
    let models: [DesktopRegenerateModel]
    /// The model that wrote this answer, or the conversation's.
    let currentModelID: String?
    let isOpen: Bool
    let regenerate: (MessageRegenerateRequest) -> Void

    var body: some View {
        Menu {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                switch item {
                case .tryAgain:
                    Button { regenerate(.again) } label: {
                        Label { Text("Try Again") } icon: { JunoIconView(.refresh, size: 16) }
                    }
                case .switchModel:
                    Menu {
                        switchModelContent
                    } label: {
                        Label { Text("Switch Model") } icon: { JunoIconView(.cube, size: 16) }
                    }
                case .divider:
                    Divider()
                case .moreConcise:
                    Button { regenerate(.instruction(MessageRegenerateRequest.moreConcise)) } label: {
                        Label { Text("More Concise") } icon: { JunoIconView(.listDashes, size: 16) }
                    }
                case .addDetails:
                    Button { regenerate(.instruction(MessageRegenerateRequest.addDetails)) } label: {
                        Label { Text("Add Details") } icon: { JunoIconView(.listPlus, size: 16) }
                    }
                }
            }
        } label: {
            // The web pulls the caret 4px into its 32px circle's rim; in the
            // Mac's 28pt circle that puts it on the rim, so the pair is simply
            // centred, which centres its ink.
            HStack(spacing: 2) {
                JunoIconView(.refresh, size: 16)
                JunoIconView(.chevronDown, size: 12, weight: .bold)
                    .opacity(0.6)
            }
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(MessageActionButtonStyle(isOpen: isOpen))
        .contentShape(Circle())
        .focusEffectDisabled()
        .fixedSize()
        .help("Regenerate")
        .accessibilityLabel("Regenerate")
    }

    /// One section per provider, each model a toggle whose check is the
    /// system's — the web's coral check is a deliberate difference (§0.8).
    @ViewBuilder
    private var switchModelContent: some View {
        if models.isEmpty {
            Text("No other models available.")
        } else {
            ForEach(DesktopRegenerateModel.grouped(models), id: \.provider) { group in
                Section(group.providerLabel) {
                    ForEach(group.models) { option in
                        Toggle(isOn: Binding(
                            get: { option.id == currentModelID },
                            set: { _ in regenerate(.model(option.id)) }
                        )) {
                            if let mark = DesktopProviderMenuMark.image(for: option.provider) {
                                Label { Text(option.name) } icon: { Image(nsImage: mark) }
                            } else {
                                Text(option.name)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// More ▾ — Read Aloud · Branch ▸ · Share Chat… · Quote in Composer · Copy
/// Link · the receipt.
struct MessageMoreMenu: View {
    let items: [MessageMenuModel.MoreItem]
    let actions: MessageRowActions
    /// The raw words on screen — what Read Aloud reads and Quote quotes.
    var content = ""
    let isOpen: Bool
    /// A branch is on its way to the server: the trigger wears the wait.
    var isBranching = false

    var body: some View {
        Menu {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                switch item {
                case .readAloud:
                    Button { actions.readAloud?(content) } label: {
                        Label { Text("Read Aloud") } icon: { JunoIconView(.volume, size: 16) }
                    }
                case .stopReading:
                    Button { actions.stopReading?() } label: {
                        Label { Text("Stop Reading") } icon: { JunoIconView(.square, size: 16, isOn: true) }
                    }
                case .branch(let destinations):
                    Menu {
                        ForEach(Array(destinations.enumerated()), id: \.offset) { _, destination in
                            switch destination {
                            case .intoNewChat:
                                Button { actions.branch?() } label: {
                                    Label { Text("Into a New Saved Chat") } icon: { JunoIconView(.branch, size: 16) }
                                }
                            case .forkPrivately:
                                Button { actions.forkPrivately?() } label: {
                                    Label { Text("Fork Privately") } icon: { JunoIconView(.fork, size: 16) }
                                }
                            }
                        }
                    } label: {
                        Label { Text("Branch from Here") } icon: { JunoIconView(.branch, size: 16) }
                    }
                case .shareChat:
                    Button { actions.share?() } label: {
                        Label { Text("Share Chat…") } icon: { JunoIconView(.share, size: 16) }
                    }
                case .divider:
                    Divider()
                case .quote:
                    Button { actions.quote?(content) } label: {
                        Label { Text("Quote in Composer") } icon: { JunoIconView(.quote, size: 16) }
                    }
                case .copyLink:
                    Button { actions.copyLink?() } label: {
                        Label { Text("Copy Link") } icon: { JunoIconView(.link, size: 16) }
                    }
                case .info(let model, let meta):
                    // Information, not an action. NSMenu draws these greyed; the web
                    // keeps them at full ink — a deliberate difference (§0.8).
                    Section {
                        if let model { Text(model) }
                        if let meta {
                            Text(meta)
                                .font(.caption)
                                .monospaced()
                        }
                    }
                }
            }
        } label: {
            Group {
                if isBranching {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    JunoIconView(.more, size: 16)
                }
            }
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(MessageActionButtonStyle(isOpen: isOpen))
        .contentShape(Circle())
        .focusEffectDisabled()
        .fixedSize()
        .disabled(isBranching)
        .help("More")
        .accessibilityLabel("More actions")
    }
}

// MARK: - Version pager

/// `‹ 2/3 ›` — which revision of a turn is showing. Mac-only; the phone keeps
/// the shared `NativeBranchNavigator`.
///
/// Its arrows are 24pt circles in the actions' own recipe (the web's 28 less
/// the same 4 the actions give up), the count 11pt mono in secondary ink. A
/// disabled arrow names nothing: a control that cannot act needs no tooltip.
struct MessageVersionPager: View {
    /// The page shown, from zero, and how many there are.
    let index: Int
    let total: Int
    let isEnabled: Bool
    /// The earlier versions are on their way: both arrows wait.
    var isLoading = false
    let step: (Int) -> Void

    init(index: Int, total: Int, isEnabled: Bool, isLoading: Bool = false, step: @escaping (Int) -> Void) {
        self.index = index
        self.total = total
        self.isEnabled = isEnabled
        self.isLoading = isLoading
        self.step = step
    }

    /// A branch's pager: its place among its siblings.
    init(position: NativeMessageBranchPosition, isEnabled: Bool, step: @escaping (Int) -> Void) {
        self.init(index: position.index, total: position.siblingsCount, isEnabled: isEnabled, step: step)
    }

    private var canGoBack: Bool { isEnabled && !isLoading && index > 0 }
    private var canGoForward: Bool { isEnabled && !isLoading && index < total - 1 }

    var body: some View {
        HStack(spacing: 0) {
            arrow(.chevronLeft, label: "Previous version", enabled: canGoBack) { step(-1) }
            Text(verbatim: "\(index + 1)/\(total)")
                .junoFont(size: 11, relativeTo: .caption, design: .monospaced)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                .frame(minWidth: 21)
                .multilineTextAlignment(.center)
                .accessibilityLabel("Version")
                .accessibilityValue("\(index + 1) of \(total)")
            arrow(.chevronRight, label: "Next version", enabled: canGoForward) { step(1) }
        }
        .padding(.trailing, 4)
    }

    private func arrow(
        _ icon: JunoIcon,
        label: String,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            JunoIconView(icon, size: 14, weight: .regular)
        }
        .buttonStyle(MessageActionButtonStyle(diameter: 24))
        .contentShape(Circle())
        .focusEffectDisabled()
        .disabled(!enabled)
        .help(enabled ? label : "")
        .accessibilityLabel(label)
    }
}

// MARK: - Switch Model's list

extension DesktopRegenerateModel {
    struct ProviderGroup {
        let provider: String
        let providerLabel: String
        let models: [DesktopRegenerateModel]
    }

    /// The models grouped by provider, in the catalog's own order.
    static func grouped(_ models: [DesktopRegenerateModel]) -> [ProviderGroup] {
        var order: [String] = []
        var byProvider: [String: [DesktopRegenerateModel]] = [:]
        for model in models {
            if byProvider[model.provider] == nil { order.append(model.provider) }
            byProvider[model.provider, default: []].append(model)
        }
        return order.map { provider in
            let list = byProvider[provider] ?? []
            return ProviderGroup(
                provider: provider,
                providerLabel: list.first?.providerLabel ?? provider,
                models: list
            )
        }
    }
}

/// A provider's mark as a menu can hold it: a 16pt template image, made once.
///
/// NSMenu takes an image per item and none per section header, so the mark
/// rides on each model. Template, so the menu inks it like its own glyphs.
@MainActor
enum DesktopProviderMenuMark {
    private static var cache: [String: NSImage] = [:]
    private static var missing: Set<String> = []

    static func image(for providerID: String) -> NSImage? {
        let key = providerID.lowercased()
        if let cached = cache[key] { return cached }
        guard !missing.contains(key),
            let source = NSImage(named: "provider-\(key)")
        else {
            missing.insert(key)
            return nil
        }
        let side: CGFloat = 16
        let mark = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            source.draw(in: rect)
            return true
        }
        mark.isTemplate = true
        cache[key] = mark
        return mark
    }
}

// MARK: - Read aloud

/// The one voice reading a reply aloud, shared by the whole transcript so a
/// second Read Aloud stops the first — and so a row can tell that it is the
/// one being read, which turns its menu item into Stop Reading.
@MainActor
@Observable
final class DesktopSpeechPlayback: NSObject {
    /// The message being read, or nil when nothing is playing.
    private(set) var playingMessageID: String?

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var audioPlayer: AVAudioPlayer?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Plays the server's audio when there is some, the system voice
    /// otherwise.
    func play(audio: Data?, fallbackText: String, messageID: String) throws {
        stop()
        if let audio {
            let player = try AVAudioPlayer(data: audio)
            player.delegate = self
            player.prepareToPlay()
            player.play()
            audioPlayer = player
        } else {
            synthesizer.speak(AVSpeechUtterance(string: fallbackText))
        }
        playingMessageID = messageID
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        audioPlayer?.stop()
        audioPlayer = nil
        playingMessageID = nil
    }

    fileprivate func finished() {
        audioPlayer = nil
        playingMessageID = nil
    }
}

extension DesktopSpeechPlayback: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully _: Bool) {
        Task { @MainActor in self.finished() }
    }
}

extension DesktopSpeechPlayback: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_: AVSpeechSynthesizer, didFinish _: AVSpeechUtterance) {
        Task { @MainActor in self.finished() }
    }
}
